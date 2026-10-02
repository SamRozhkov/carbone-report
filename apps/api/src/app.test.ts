import { describe, expect, it } from 'vitest';
import { buildApp } from './app';

describe('buildApp', () => {
  it('GET /api/health → 200 {status:"ok"}', async () => {
    const app = await buildApp({});
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    await app.close();
  });
});
