import { describe, expect, it } from 'vitest';
import { createFastify, logUrl } from './app';

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

describe('logUrl: URL запроса в журнале', () => {
  it('у маршрутов OIDC query не пишется (код авторизации и state)', () => {
    expect(logUrl('/api/auth/oidc/callback?code=secret-code&state=abc')).toBe(
      '/api/auth/oidc/callback',
    );
    expect(logUrl('/api/auth/oidc/login?next=/reports')).toBe('/api/auth/oidc/login');
  });
  it('проверка по декодированному пути: %6fidc тоже маршрут OIDC', () => {
    expect(logUrl('/api/auth/%6fidc/callback?code=X&state=Y')).toBe('/api/auth/%6fidc/callback');
    expect(logUrl('/api/auth/oidc/callback?code=X')).toBe('/api/auth/oidc/callback');
  });
  it('битая кодировка не бросает исключение', () => {
    expect(logUrl('/api/x%?a=1')).toBe('/api/x%');
  });
  it('у прочих маршрутов скрыт только токен файлового доступа', () => {
    expect(logUrl('/api/files/x?t=token&a=1')).toBe('/api/files/x?t=***&a=1');
    expect(logUrl('/api/runs/1/file?t=abc')).toBe('/api/runs/1/file?t=***');
    expect(logUrl('/api/reports?page=2')).toBe('/api/reports?page=2');
  });
});
