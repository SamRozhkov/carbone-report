// Маршруты ИИ-ассистента (§50).
import { AssistantSettingsBody } from '@carbone-reports/shared';
import type { App } from '../../app';
import type { AppDeps } from '../../deps';
import type { Guards } from '../auth/guards';
import { loadAssistantSettings, saveAssistantSettings, toSettingsDto } from './settings';

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
}
