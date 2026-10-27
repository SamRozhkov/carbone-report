// Маршруты ИИ-ассистента (§50).
import {
  AssistantSettingsBody,
  AssistantTestBody,
  type AssistantTestResult,
} from '@carbone-reports/shared';
import type { App } from '../../app';
import type { AppDeps } from '../../deps';
import { AppError, translateMsg } from '../../lib/errors';
import type { Guards } from '../auth/guards';
import { createLlmClient, LlmError, testLlm } from './llm';
import { loadAssistantSettings, saveAssistantSettings, toSettingsDto } from './settings';

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
}
