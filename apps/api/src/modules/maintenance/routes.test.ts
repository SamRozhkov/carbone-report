import type { Redis } from 'ioredis';
import { afterEach, describe, expect, it } from 'vitest';
import { createFastify, registerHealthRoutes, type App, type AppDeps } from '../../app';
import { createRenderHandoff } from '../render/handoff';
import { registerRenderRoutes } from '../render/routes';
import { MAINTENANCE_KEY } from './flag';
import { registerMaintenance } from './routes';

const SECRET = new TextEncoder().encode('test-secret-test-secret-test-secret');
const FLAG = JSON.stringify({ phase: 'db', startedAt: '2026-10-09T10:00:00.000Z', backup: 'b1' });

/** Заглушка Redis: режим обслуживания включён, если задан флаг. */
function fakeRedis(flag: string | null): Redis {
  return {
    get: async (key: string) => (key === MAINTENANCE_KEY ? flag : null),
  } as unknown as Redis;
}

async function build(opts: { flag: string | null; draining?: boolean }) {
  const handoff = createRenderHandoff(SECRET);
  const deps = {
    redis: fakeRedis(opts.flag),
    backupAgent: null,
    sources: { closeAll: async () => {} },
    drain: opts.draining === undefined ? undefined : { isDraining: () => opts.draining! },
  } as unknown as AppDeps;
  const app = createFastify();
  registerMaintenance(app, deps);
  registerHealthRoutes(app, deps);
  app.get('/api/templates', async () => []);
  app.post('/api/templates/export', async () => 'zip');
  app.post('/api/templates/import', async () => 'imported');
  app.post('/api/templates/import/preview', async () => 'preview');
  registerRenderRoutes(app, handoff);
  await app.ready();
  return { app, handoff };
}

describe('режим обслуживания: белый список', () => {
  let app: App | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('разовая ссылка рендера отдаёт файл, остальные маршруты — 503, /api/ready — 200', async () => {
    const t = await build({ flag: FLAG });
    app = t.app;
    const { id, token } = await t.handoff.put(Buffer.from('pdf'), 'docx', Date.now() + 60_000);
    const file = await app.inject({
      method: 'GET',
      url: `/internal/render-files/${id}?t=${encodeURIComponent(token)}`,
    });
    expect(file.statusCode).toBe(200);
    expect(file.body).toBe('pdf');
    expect((await app.inject({ method: 'GET', url: '/api/templates' })).statusCode).toBe(503);
    expect((await app.inject({ method: 'GET', url: '/api/ready' })).statusCode).toBe(200);
  });

  it('выгрузка шаблонов доступна, загрузка из архива — 503', async () => {
    const t = await build({ flag: FLAG });
    app = t.app;
    expect((await app.inject({ method: 'POST', url: '/api/templates/export' })).statusCode).toBe(
      200,
    );
    expect((await app.inject({ method: 'POST', url: '/api/templates/import' })).statusCode).toBe(
      503,
    );
    expect(
      (await app.inject({ method: 'POST', url: '/api/templates/import/preview' })).statusCode,
    ).toBe(503);
  });

  it('префикс только для GET', async () => {
    const t = await build({ flag: FLAG });
    app = t.app;
    const r = await app.inject({ method: 'POST', url: '/internal/render-files/abc' });
    expect(r.statusCode).toBe(503);
  });
});

describe('GET /api/ready', () => {
  let app: App | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('при остановке — 503 { status: draining }, /api/health — 200', async () => {
    const t = await build({ flag: null, draining: true });
    app = t.app;
    const ready = await app.inject({ method: 'GET', url: '/api/ready' });
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({ status: 'draining' });
    expect((await app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
  });

  it('без drain и при isDraining() === false — 200 { status: ok }', async () => {
    for (const draining of [undefined, false]) {
      const t = await build({ flag: null, draining });
      const r = await t.app.inject({ method: 'GET', url: '/api/ready' });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ status: 'ok' });
      await t.app.close();
    }
  });
});
