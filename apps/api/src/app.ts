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
import { makeGuards } from './modules/auth/guards';
import { registerAuthRoutes } from './modules/auth/routes';
import { registerDatasourceRoutes } from './modules/datasources/routes';
import { registerOnlyOfficeRoutes } from './modules/onlyoffice/routes';
import { registerReportRoutes } from './modules/reports/routes';
import { registerTemplateRoutes } from './modules/templates/routes';
import { registerUserRoutes } from './modules/users/routes';

export type { AppDeps };

export function createFastify() {
  const app = Fastify({
    logger: process.env.NODE_ENV === 'test' || process.env.VITEST ? false : { level: 'info' },
    bodyLimit: 25 * 1024 * 1024,
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
  await app.register(rateLimit, { global: false });
  await app.register(multipart, { limits: { fileSize: 20 * 1024 * 1024, files: 1 } });
  const guards = makeGuards(deps);

  app.get('/api/health', async () => ({ status: 'ok' }));
  registerAuthRoutes(app, deps, guards);
  registerUserRoutes(app, deps, guards);
  registerDatasourceRoutes(app, deps, guards);
  registerTemplateRoutes(app, deps, guards);
  registerReportRoutes(app, deps, guards);
  registerOnlyOfficeRoutes(app, deps, guards);

  await app.ready();
  return app;
}
