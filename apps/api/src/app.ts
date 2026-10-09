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
import { registerBackupRoutes } from './modules/backups/routes';
import { registerMaintenance } from './modules/maintenance/routes';
import { registerOnlyOfficeRoutes } from './modules/onlyoffice/routes';
import { registerRenderRoutes } from './modules/render/routes';
import { registerReportRoutes } from './modules/reports/routes';
import { registerTemplateRoutes } from './modules/templates/routes';
import { registerUserRoutes } from './modules/users/routes';

export type { AppDeps };

/** Токен файлового доступа передаётся в query-параметре t: в логи он не попадает. */
export const redactToken = (url?: string) => url?.replace(/([?&])t=[^&]*/g, '$1t=***');

/**
 * Сколько прокси стоит перед API. Сейчас один — nginx: req.ip — последний адрес
 * X-Forwarded-For, его дописывает nginx; адреса, подставленные клиентом левее, не
 * учитываются. Если перед nginx появится ещё один прокси, число нужно увеличить.
 * Менять нужно именно эту константу, а не `trustProxy`: число в `trustProxy` Fastify 5
 * не доверяет ни одному хопу, и все клиенты получат адрес nginx. Заголовок
 * X-Forwarded-Host при доверии тоже учитывается, его задаёт nginx (docker/nginx/templates/common.conf.template).
 * Значение по умолчанию; в работе — `config.trustedProxyHops` (TRUSTED_PROXY_HOPS, чарт Helm ставит 2: Ingress и nginx).
 */
export const TRUSTED_PROXY_HOPS = 1;

/**
 * Доверие по числу прокси-хопов (как `trustProxy: n` в Fastify 4). Fastify 5.12 число
 * в `trustProxy` не доверяет ни одному хопу (req.ip — адрес nginx у всех клиентов),
 * поэтому то же правило задано функцией: хоп 0 — сокет (nginx), ему верим.
 */
export const trustProxyHops = (hops: number) => (_addr: string, hop: number) => hop < hops;

export function createFastify(hops: number = TRUSTED_PROXY_HOPS) {
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
    trustProxy: trustProxyHops(hops),
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  return app;
}

export type App = ReturnType<typeof createFastify>;

/** health — startup/liveness; ready — readiness: при остановке пода отвечает 503, чтобы балансировщик снял реплику. */
/** Не ждём при остановке: пробы и разовые ссылки, по которым Document Server забирает файл ждущего отчёта. */
const UNTRACKED = /^\/(api\/health|api\/ready|internal\/render-files\/)/;

/** Считает незавершённые запросы для дренажа: отчёт на этапе SQL тоже должен успеть до закрытия. */
export function registerInflight(app: App, deps: Pick<AppDeps, 'drain'>): void {
  const requests = deps.drain?.requests;
  if (!requests) return;
  app.addHook('onRequest', async (req, reply) => {
    if (UNTRACKED.test(req.url)) return;
    requests.enter();
    reply.raw.once('close', () => requests.leave());
  });
}

export function registerHealthRoutes(app: App, deps: Pick<AppDeps, 'drain'>): void {
  app.get('/api/health', async () => ({ status: 'ok' }));
  app.get('/api/ready', async (_req, reply) =>
    deps.drain?.isDraining()
      ? reply.status(503).send({ status: 'draining' })
      : reply.send({ status: 'ok' }),
  );
}

export async function buildApp(deps: AppDeps): Promise<App> {
  const app = createFastify(deps.config.trustedProxyHops);
  registerErrorHandler(app);
  registerInflight(app, deps);
  // До всех маршрутов: во время восстановления из бэкапа API отвечает 503 (§26.3).
  registerMaintenance(app, deps);
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

  registerHealthRoutes(app, deps);
  registerAuthRoutes(app, deps, guards);
  registerUserRoutes(app, deps, guards);
  registerAccessRoutes(app, deps, guards);
  registerDatasourceRoutes(app, deps, guards);
  registerTemplateRoutes(app, deps, guards);
  registerReportRoutes(app, deps, guards);
  registerOnlyOfficeRoutes(app, deps, guards);
  registerRenderRoutes(app, deps.renderFiles);
  registerBackupRoutes(app, deps, guards);

  await app.ready();
  return app;
}
