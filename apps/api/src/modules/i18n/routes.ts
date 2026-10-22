import { LocaleBody, type I18nInfo } from '@carbone-reports/shared';
import { eq } from 'drizzle-orm';
import type { App } from '../../app';
import { users } from '../../db/schema';
import type { AppDeps } from '../../deps';
import { currentUser, type Guards } from '../auth/guards';

/** Язык интерфейса (§44.1). */
export function registerI18nRoutes(
  app: App,
  deps: Pick<AppDeps, 'config' | 'db'>,
  guards: Pick<Guards, 'requireUser'>,
): void {
  // Без входа: язык страницы входа, когда браузер не дал подходящего.
  app.get('/api/i18n', async (): Promise<I18nInfo> => ({
    defaultLocale: deps.config.defaultLocale,
  }));

  // Любая роль; null — «Как в браузере».
  app.put(
    '/api/me/locale',
    { preHandler: guards.requireUser, schema: { body: LocaleBody } },
    async (req, reply) => {
      await deps.db
        .update(users)
        .set({ locale: req.body.locale })
        .where(eq(users.id, currentUser(req).id));
      return reply.status(204).send();
    },
  );
}
