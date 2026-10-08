import { describe, expect, it } from 'vitest';
import { mockApi } from '../test/utils';
import { apiJson, ApiRequestError } from './client';
import { isMaintenanceReported, resetMaintenance } from './maintenance';

describe('apiJson', () => {
  it('ошибка сервера в формате {error} → ApiRequestError с кодом, сообщением и details', async () => {
    mockApi([
      {
        method: 'POST',
        path: '/api/x',
        status: 400,
        body: {
          error: {
            code: 'VALIDATION',
            message: 'неверные параметры',
            details: { fields: { a: 'плохо' } },
          },
        },
      },
    ]);
    const err = await apiJson('/api/x', { method: 'POST', json: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(ApiRequestError);
    expect(err).toMatchObject({
      status: 400,
      code: 'VALIDATION',
      message: 'неверные параметры',
      details: { fields: { a: 'плохо' } },
    });
  });

  it('ответ не-JSON → общее сообщение с кодом HTTP', async () => {
    mockApi([{ path: '/api/x', status: 502, raw: '<html>bad gateway</html>' }]);
    await expect(apiJson('/api/x')).rejects.toMatchObject({
      status: 502,
      message: 'ошибка сервера (HTTP 502)',
    });
  });

  it('204 → undefined', async () => {
    mockApi([{ method: 'DELETE', path: '/api/x', status: 204 }]);
    await expect(apiJson('/api/x', { method: 'DELETE' })).resolves.toBeUndefined();
  });

  it('сетевая ошибка → NETWORK', async () => {
    const { vi } = await import('vitest');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    await expect(apiJson('/api/x')).rejects.toMatchObject({
      code: 'NETWORK',
      message: 'нет связи с сервером',
    });
  });
});

describe('режим обслуживания', () => {
  it('503 с кодом maintenance включает экран обслуживания; другие ошибки — нет', async () => {
    mockApi([
      { path: '/api/a', status: 503, body: { error: { code: 'INTERNAL', message: 'x' } } },
      {
        path: '/api/b',
        status: 503,
        body: {
          error: { code: 'maintenance', message: 'идёт восстановление из бэкапа, повторите позже' },
        },
      },
    ]);
    try {
      await apiJson('/api/a').catch(() => {});
      expect(isMaintenanceReported()).toBe(false);
      const err = await apiJson('/api/b').catch((e: unknown) => e);
      expect(err).toMatchObject({ status: 503, code: 'maintenance' });
      expect(isMaintenanceReported()).toBe(true);
    } finally {
      resetMaintenance();
    }
  });
});
