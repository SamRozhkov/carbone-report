import type { App } from '../../app';
import type { AppDeps } from '../../deps';
import type { Guards } from '../auth/guards';

/** Версия сборки сервера: только для вошедших (любая роль), как остальные /api/*. */
export function registerVersionRoutes(
  app: App,
  deps: Pick<AppDeps, 'config'>,
  guards: Pick<Guards, 'requireUser'>,
): void {
  app.get('/api/version', { preHandler: guards.requireUser }, async () => ({
    version: deps.config.appVersion,
    commit: deps.config.appCommit,
    builtAt: deps.config.appBuildDate,
  }));
}
