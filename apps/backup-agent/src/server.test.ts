import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OperationView } from './agent';
import { buildServer, type AgentApi } from './server';

const TOKEN = 'k'.repeat(40);
const auth = { authorization: `Bearer ${TOKEN}` };
const NAME = '2026-10-08T03-00-00Z';

let root: string;
let agent: { [K in keyof AgentApi]: ReturnType<typeof vi.fn> };
let app: ReturnType<typeof buildServer>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'srv-'));
  await mkdir(join(root, NAME));
  agent = {
    startBackup: vi.fn(async () => ({ operationId: 'op1' })),
    startRestore: vi.fn(async () => ({ operationId: 'op2' })),
    recover: vi.fn(async () => ({ operationId: 'op3' })),
    operation: vi.fn(async () => null),
  };
  app = buildServer({ agent: agent as unknown as AgentApi, token: TOKEN, backupsDir: root });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});

describe('авторизация', () => {
  it('/health без токена — 200', async () => {
    const r = await app.inject({ method: 'GET', url: '/health' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ status: 'ok' });
  });
  it.each([
    ['без заголовка', {}],
    ['неверный токен', { authorization: `Bearer ${'x'.repeat(40)}` }],
    ['токен другой длины', { authorization: 'Bearer short' }],
    ['другая схема', { authorization: `Basic ${TOKEN}` }],
  ])('%s — 401', async (_n, headers) => {
    const r = await app.inject({ method: 'GET', url: '/backups', headers });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({
      error: { code: 'UNAUTHORIZED', message: 'требуется токен агента' },
    });
    expect(r.body).not.toContain(TOKEN);
  });
});

describe('маршруты', () => {
  it('GET /backups — список каталога', async () => {
    const r = await app.inject({ method: 'GET', url: '/backups', headers: auth });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual([
      expect.objectContaining({ name: NAME, status: 'partial', kind: 'regular' }),
    ]);
  });

  it('POST /backups — 202 и requestedBy; без тела — api', async () => {
    let r = await app.inject({
      method: 'POST',
      url: '/backups',
      headers: auth,
      payload: { requestedBy: 'admin' },
    });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toEqual({ operationId: 'op1' });
    expect(agent.startBackup).toHaveBeenCalledWith('admin');
    r = await app.inject({ method: 'POST', url: '/backups', headers: auth });
    expect(r.statusCode).toBe(202);
    expect(agent.startBackup).toHaveBeenLastCalledWith('api');
  });

  it('занято — 409 с busy и текстом ошибки', async () => {
    agent.startBackup.mockResolvedValueOnce({
      busy: { type: 'restore', startedAt: '2026-10-08T10:00:00.000Z' },
    });
    const r = await app.inject({ method: 'POST', url: '/backups', headers: auth, payload: {} });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({
      error: { code: 'BUSY', message: 'уже выполняется другая операция с бэкапами' },
      busy: { type: 'restore', startedAt: '2026-10-08T10:00:00.000Z' },
    });
  });

  it('restore: неверное имя — 400, нет каталога — 404, .partial — 400; агент не вызывается', async () => {
    for (const [name, code] of [
      ['..%2Fetc', 400],
      [`${NAME}.partial`, 400],
      ['2026-10-09T03-00-00Z', 404],
    ] as const) {
      const r = await app.inject({
        method: 'POST',
        url: `/backups/${name}/restore`,
        headers: auth,
        payload: {},
      });
      expect(r.statusCode).toBe(code);
    }
    expect(agent.startRestore).not.toHaveBeenCalled();
  });

  it('restore: 202, имя и логин передаются агенту', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/backups/${NAME}/restore`,
      headers: auth,
      payload: { requestedBy: 'admin' },
    });
    expect(r.statusCode).toBe(202);
    expect(agent.startRestore).toHaveBeenCalledWith(NAME, 'admin');
  });

  it('GET /operation: 204 без операций, 200 с операцией', async () => {
    expect((await app.inject({ method: 'GET', url: '/operation', headers: auth })).statusCode).toBe(
      204,
    );
    const view = {
      id: 'op1',
      status: 'running',
      log: ['этап: db'],
      recovery: null,
    } as unknown as OperationView;
    agent.operation.mockResolvedValueOnce(view);
    const r = await app.inject({ method: 'GET', url: '/operation', headers: auth });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual(view);
  });

  it('POST /recovery: 202, 403 неверный код, 403 со сгоревшим кодом, 409 без состояния, 400 без цели', async () => {
    const call = (payload: unknown) =>
      app.inject({ method: 'POST', url: '/recovery', headers: auth, payload: payload as object });
    let r = await call({ code: 'ABCD-EFGH-IJKL', target: 'same' });
    expect(r.statusCode).toBe(202);
    expect(agent.recover).toHaveBeenCalledWith('ABCD-EFGH-IJKL', 'same');

    agent.recover.mockResolvedValueOnce({ error: 'bad-code', burned: false });
    r = await call({ code: 'X', target: 'pre-restore' });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toEqual({ code: 'BAD_CODE', message: 'неверный код восстановления' });

    agent.recover.mockResolvedValueOnce({ error: 'bad-code', burned: true });
    r = await call({ code: 'X', target: 'same' });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.message).toContain('новый код в журнале сервиса backup');

    agent.recover.mockResolvedValueOnce({ error: 'no-recovery' });
    r = await call({ code: 'X', target: 'same' });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('NO_RECOVERY');

    agent.recover.mockResolvedValueOnce({ error: 'bad-target' });
    r = await call({ code: 'X', target: 'pre-restore' });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toEqual({ code: 'BAD_TARGET', message: 'нет бэкапа до восстановления' });

    r = await call({ code: 'X' });
    expect(r.statusCode).toBe(400);
  });
});
