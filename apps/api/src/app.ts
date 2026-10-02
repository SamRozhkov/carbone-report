import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { registerErrorHandler } from './lib/errors';

// Временный вид; финальный AppDeps появится в src/deps.ts (Task 3).
export type AppDeps = Record<string, never>;

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

export async function buildApp(_deps: AppDeps): Promise<App> {
  const app = createFastify();
  registerErrorHandler(app);
  app.get('/api/health', async () => ({ status: 'ok' }));
  await app.ready();
  return app;
}
