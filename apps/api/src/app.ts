import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import type { AppDeps } from './deps';
import { registerErrorHandler } from './lib/errors';
import { fallbackStore } from './lib/fallback-store';
import { makeGuards } from './modules/auth/guards';
import { registerAccessRoutes } from './modules/access/routes';
import { registerAuthRoutes } from './modules/auth/routes';
import { registerDatasourceRoutes } from './modules/datasources/routes';
import { registerOnlyOfficeRoutes } from './modules/onlyoffice/routes';
import { registerReportRoutes } from './modules/reports/routes';
import { registerTemplateRoutes } from './modules/templates/routes';
import { registerUserRoutes } from './modules/users/routes';

export type { AppDeps };

/** Токен файлового доступа передаётся в query-параметре t: в логи он не попадает. */
export const redactToken = (url?: string) => url?.replace(/([?&])t=[^&]*/g, '$1t=***');

export function createFastify() {
  const app = Fastify({
    logger:
      process.env.NODE_ENV === 'test' || process.env.VITEST
        ? false
        : {
            level: 'info',
            serializers: {
              req: (req: { method?: string; url?: string }) => ({
                method: req.method,
                url: redactToken(req.url),
              }),
            },
          },
    bodyLimit: 1024 * 1024,
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  return app;
}

export type App = ReturnType<typeof createFastify>;

export async function buildApp(deps: AppDeps): Promise<App> {
  const app = createFastify();
  registerErrorHandler(app);
  await app.register(cookie);
  // Счётчики входа общие для всех экземпляров API (Redis, ключи cr:rl:). Если Redis
  // ответил ошибкой (команда сразу отклоняется при enableOfflineQueue: false или падает
  // по commandTimeout), лимит считается в памяти экземпляра, и 5 с Redis не спрашивается.
  // Плагин не передаёт redis/nameSpace своему store — они заданы в fallbackStore.
  await app.register(rateLimit, {
    global: false,
    ...(deps.redis
      ? { store: fallbackStore({ redis: deps.redis, nameSpace: 'cr:rl:', log: app.log }) }
      : {}),
  });
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 1 } });
  const guards = makeGuards(deps);

  app.get('/api/health', async () => ({ status: 'ok' }));
  registerAuthRoutes(app, deps, guards);
  registerUserRoutes(app, deps, guards);
  registerAccessRoutes(app, deps, guards);
  registerDatasourceRoutes(app, deps, guards);
  registerTemplateRoutes(app, deps, guards);
  registerReportRoutes(app, deps, guards);
  registerOnlyOfficeRoutes(app, deps, guards);

  await app.ready();
  return app;
}
