// Маршруты ИИ-ассистента (§50).
import {
  AssistantChatBody,
  type AssistantChatReply,
  AssistantSettingsBody,
  AssistantTestBody,
  type AssistantTestResult,
} from '@carbone-reports/shared';
import type { FastifyRequest } from 'fastify';
import type { App } from '../../app';
import type { AppDeps } from '../../deps';
import { AppError, notFound, translateMsg } from '../../lib/errors';
import { currentUser, type Guards } from '../auth/guards';
import { AgentLimitError, runAgent } from './agent';
import { createLlmClient, LlmError, testLlm } from './llm';
import { systemPrompt } from './prompt';
import { loadAssistantSettings, saveAssistantSettings, toSettingsDto } from './settings';
import { createAssistantTools, type Inject } from './tools';

/** Ошибка модели → ответ 502 с кодом; detail — только в журнал (internal). */
export const llmAppError = (e: LlmError) =>
  new AppError(
    `ASSISTANT_${e.code.toUpperCase()}`,
    502,
    { key: `assistant.${e.code}` },
    undefined,
    e.detail,
  );

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
      try {
        return await runAgent({
          llm: createLlmClient({ baseUrl: s.baseUrl, model: s.model, apiKey: s.apiKey }),
          tools: createAssistantTools({
            inject,
            deps,
            locale: req.locale,
            onError: (tool, status, body) =>
              req.log.warn({ tool, status, body }, 'ошибка эндпоинта в инструменте ассистента'),
          }),
          system: systemPrompt({
            locale: req.locale,
            today,
            extra: s.extraInstructions,
            page: req.body.page,
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
