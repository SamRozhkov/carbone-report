import { describe, expect, it } from 'vitest';
import { createFastify } from './app';

async function ipFor(hops: number | undefined, xff: string): Promise<string> {
  const app = createFastify(hops);
  app.get('/ip', async (req) => ({ ip: req.ip }));
  const r = await app.inject({ method: 'GET', url: '/ip', headers: { 'x-forwarded-for': xff } });
  await app.close();
  return (r.json() as { ip: string }).ip;
}

describe('createFastify: доверенные прокси', () => {
  it('по умолчанию 1 хоп (nginx): клиент — последний адрес X-Forwarded-For', async () => {
    expect(await ipFor(undefined, '203.0.113.7, 10.0.0.5')).toBe('10.0.0.5');
  });
  it('2 хопа (Ingress и nginx): клиент — адрес до Ingress, подставленное клиентом не учитывается', async () => {
    expect(await ipFor(2, '198.51.100.1, 203.0.113.7, 10.0.0.5')).toBe('203.0.113.7');
  });
});
