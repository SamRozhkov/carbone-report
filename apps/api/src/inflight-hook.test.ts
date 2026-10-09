import { describe, expect, it } from 'vitest';
import { createFastify, registerHealthRoutes, registerInflight, type AppDeps } from './app';
import { createInflight } from './lib/inflight';

describe('registerInflight', () => {
  it('ждёт идущий запрос; пробы и разовые ссылки рендера не считаются', async () => {
    const requests = createInflight();
    const deps = { drain: { isDraining: () => false, requests } } as unknown as AppDeps;
    const app = createFastify();
    registerInflight(app, deps);
    registerHealthRoutes(app, deps);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    app.get('/api/slow', async () => {
      await gate;
      return { ok: true };
    });
    app.get('/internal/render-files/:id', async () => 'file');
    await app.listen({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
    try {
      const slow = fetch(`${base}/api/slow`);
      await new Promise((r) => setTimeout(r, 50));
      expect(requests.active()).toBe(1);
      await fetch(`${base}/api/health`);
      await fetch(`${base}/api/ready`);
      await fetch(`${base}/internal/render-files/x`);
      expect(requests.active()).toBe(1);
      let idle = false;
      const p = requests.idle().then(() => (idle = true));
      expect(idle).toBe(false);
      release();
      expect((await slow).status).toBe(200);
      await p;
      expect(requests.active()).toBe(0);
    } finally {
      await app.close();
    }
  });
});
