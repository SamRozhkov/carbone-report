// Маршруты ИИ-ассистента (§50).
import {
  AssistantChatBody,
  type AssistantChatReply,
  AssistantSettingsBody,
  AssistantTestBody,
  type AssistantTestResult,
  type EditorDraft,
} from '@carbone-reports/shared';
import type { FastifyRequest } from 'fastify';
import type { App } from '../../app';
import type { AppDeps } from '../../deps';
import { AppError, notFound, translateMsg } from '../../lib/errors';
import { canEditTemplate } from '../access/permissions';
import { currentUser, type Guards } from '../auth/guards';
import type { SessionUser } from '../auth/session';
import { loadTemplate, loadTemplateFull } from '../templates/service';
import { AgentLimitError, runAgent } from './agent';
import { AUTHOR_MAX_TOOL_CALLS, createAuthorTools } from './author-tools';
import { createLlmClient, LlmError, testLlm } from './llm';
import { systemPrompt } from './prompt';
import { loadAssistantSettings, saveAssistantSettings, toSettingsDto } from './settings';
import { createAssistantTools, type Inject, mergeTools, UUID_RE } from './tools';

/** Ошибка модели → ответ 502 с кодом; detail — только в журнал (internal). */
export const llmAppError = (e: LlmError) =>
  new AppError(
    `ASSISTANT_${e.code.toUpperCase()}`,
    502,
    { key: `assistant.${e.code}` },
    undefined,
    e.detail,
  );

/**
 * Авторский режим (§51.3) — только если пользователь может править открытый шаблон; решается
 * здесь, на сервере. Иначе ни авторские инструменты, ни черновик редактора модели не видны.
 * Без черновика из редактора — сохранённые запросы и параметры шаблона.
 */
async function authorMode(
  deps: AppDeps,
  user: SessionUser,
  templateId: string | undefined,
  editor: EditorDraft | undefined,
): Promise<{ templateId: string; templateName: string; draft: EditorDraft } | null> {
  if (!templateId || !UUID_RE.test(templateId)) return null;
  if (!(await canEditTemplate(deps.db, user, templateId))) return null;
  try {
    if (editor)
      return {
        templateId,
        templateName: (await loadTemplate(deps.db, templateId)).name,
        draft: editor,
      };
    const full = await loadTemplateFull(deps.db, templateId);
    return {
      templateId,
      templateName: full.row.name,
      draft: {
        queries: full.queries.map(({ key, mode, sql }) => ({ key, mode, sql })),
        params: full.params,
      },
    };
  } catch (e) {
    // Шаблон удалён между проверкой и чтением — обычный режим.
    if (e instanceof AppError && e.code === 'NOT_FOUND') return null;
    throw e;
  }
}

export function registerAssistantRoutes(app: App, deps: AppDeps, guards: Guards): void {
  const admin = { preHandler: guards.requireAdmin };
  const key = deps.config.encryptionKey;

  app.get('/api/admin/assistant', admin, async () =>
    toSettingsDto(await loadAssistantSettings(deps.db, key)),
  );

  app.put(
    '/api/admin/assistant',
    { ...admin, schema: { body: AssistantSettingsBody } },
    async (req, reply) => {
      await saveAssistantSettings(deps.db, key, req.body);
      return reply.status(204).send();
    },
  );

  // Проверка подключения: ключ из формы, иначе сохранённый
  app.post(
    '/api/admin/assistant/test',
    { ...admin, schema: { body: AssistantTestBody } },
    async (req): Promise<AssistantTestResult> => {
      const apiKey =
        req.body.apiKey === undefined
          ? (await loadAssistantSettings(deps.db, key)).apiKey
          : req.body.apiKey || null;
      try {
        await testLlm(
          createLlmClient({ baseUrl: req.body.baseUrl, model: req.body.model, apiKey }),
        );
        return { ok: true };
      } catch (e) {
        if (!(e instanceof LlmError)) throw e;
        req.log.warn({ code: e.code, detail: e.detail }, 'проверка подключения к модели');
        return {
          ok: false,
          code: e.code,
          message: translateMsg(req.locale, { key: `assistant.${e.code}` }),
        };
      }
    },
  );

  // §50.3: 20 запросов в минуту на пользователя; хук после requireUser — пользователь уже известен.
  const chatRateLimit = {
    max: 20,
    timeWindow: '1 minute',
    hook: 'preHandler' as const,
    keyGenerator: (req: FastifyRequest) => `assistant:${currentUser(req).id}`,
    errorResponseBuilder: () =>
      new AppError('TOO_MANY_ATTEMPTS', 429, { key: 'assistant.tooManyRequests' }),
  };

  app.post(
    '/api/assistant/chat',
    {
      preHandler: guards.requireUser,
      config: { rateLimit: chatRateLimit },
      schema: { body: AssistantChatBody },
    },
    async (req): Promise<AssistantChatReply> => {
      const s = await loadAssistantSettings(deps.db, key);
      if (!s.enabled) throw notFound('assistant');
      // Инструменты вызывают эндпоинты от имени этого же пользователя и на его языке.
      const inject: Inject = async (method, url, payload) => {
        const r = await app.inject({
          method,
          url,
          payload: payload as object | undefined,
          headers: { cookie: req.headers.cookie ?? '', 'x-locale': req.locale },
        });
        let body: unknown;
        try {
          body = r.json();
        } catch {
          body = null;
        }
        return { status: r.statusCode, body };
      };
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: deps.config.tz }).format(
        new Date(),
      );
      const { templateId, editor, path, reportId } = req.body.page;
      const author = await authorMode(deps, currentUser(req), templateId, editor);
      const toolCtx = {
        inject,
        deps,
        locale: req.locale,
        onError: (tool: string, status: number, body: unknown) =>
          req.log.warn({ tool, status, body }, 'ошибка эндпоинта в инструменте ассистента'),
      };
      const tools = author
        ? mergeTools(
            createAssistantTools(toolCtx),
            createAuthorTools({ ...toolCtx, templateId: author.templateId, draft: author.draft }),
          )
        : createAssistantTools(toolCtx);
      try {
        return await runAgent({
          llm: createLlmClient({ baseUrl: s.baseUrl, model: s.model, apiKey: s.apiKey }),
          tools,
          maxToolCalls: author ? AUTHOR_MAX_TOOL_CALLS : undefined,
          system: systemPrompt({
            locale: req.locale,
            today,
            extra: s.extraInstructions,
            // Только путь и id отчёта: черновик редактора в промпт не попадает.
            page: { path, reportId },
            author: author ? { templateName: author.templateName } : undefined,
          }),
          history: req.body.messages,
          onToolError: (name, e) =>
            req.log.warn({ err: e, tool: name }, 'ошибка инструмента ассистента'),
        });
      } catch (e) {
        // detail ошибки модели и причина лимита — в журнал через internal (registerErrorHandler).
        if (e instanceof LlmError) throw llmAppError(e);
        if (e instanceof AgentLimitError)
          throw new AppError(
            'ASSISTANT_LIMIT',
            422,
            { key: 'assistant.limit' },
            undefined,
            e.message,
          );
        throw e;
      }
    },
  );
}
