import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, loginAs, type TestApp } from './helpers';

let t: TestApp;
let admin: { cookie: string; user: { id: string } };
let user: { cookie: string };
beforeAll(async () => {
  t = await createTestApp();
  admin = await loginAs(t, 'admin');
  user = await loginAs(t, 'user');
});
afterAll(() => t.close());

describe('users', () => {
  it('user получает 403', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/users', headers: { cookie: user.cookie } });
    expect(res.statusCode).toBe(403);
  });

  it('создание, список без хешей паролей, дубликат логина → 409', async () => {
    const create = await t.app.inject({
      method: 'POST', url: '/api/users', headers: { cookie: admin.cookie },
      payload: { login: 'ivanov', password: 'password1', role: 'user' },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json()).not.toHaveProperty('passwordHash');

    const dup = await t.app.inject({
      method: 'POST', url: '/api/users', headers: { cookie: admin.cookie },
      payload: { login: 'ivanov', password: 'password1', role: 'user' },
    });
    expect(dup.statusCode).toBe(409);

    const list = await t.app.inject({ method: 'GET', url: '/api/users', headers: { cookie: admin.cookie } });
    expect(list.json().map((u: { login: string }) => u.login)).toContain('ivanov');
    expect(JSON.stringify(list.json())).not.toMatch(/argon2/);
  });

  it('смена пароля и блокировка', async () => {
    const created = await t.app.inject({
      method: 'POST', url: '/api/users', headers: { cookie: admin.cookie },
      payload: { login: 'petrov', password: 'password1', role: 'user' },
    });
    const id = created.json().id;
    await t.app.inject({
      method: 'PATCH', url: `/api/users/${id}`, headers: { cookie: admin.cookie },
      payload: { password: 'newpassword' },
    });
    const login = await t.app.inject({
      method: 'POST', url: '/api/auth/login', payload: { login: 'petrov', password: 'newpassword' },
    });
    expect(login.statusCode).toBe(200);

    const blocked = await t.app.inject({
      method: 'PATCH', url: `/api/users/${id}`, headers: { cookie: admin.cookie }, payload: { blocked: true },
    });
    expect(blocked.json().blocked).toBe(true);
  });

  it('админ не может заблокировать, понизить или удалить сам себя', async () => {
    const self = `/api/users/${admin.user.id}`;
    const block = await t.app.inject({ method: 'PATCH', url: self, headers: { cookie: admin.cookie }, payload: { blocked: true } });
    const demote = await t.app.inject({ method: 'PATCH', url: self, headers: { cookie: admin.cookie }, payload: { role: 'user' } });
    const del = await t.app.inject({ method: 'DELETE', url: self, headers: { cookie: admin.cookie } });
    expect([block.statusCode, demote.statusCode, del.statusCode]).toEqual([400, 400, 400]);
  });

  it('несуществующий id → 404, невалидный uuid → 400', async () => {
    const r404 = await t.app.inject({
      method: 'PATCH', url: '/api/users/00000000-0000-0000-0000-000000000000',
      headers: { cookie: admin.cookie }, payload: { blocked: true },
    });
    const r400 = await t.app.inject({
      method: 'PATCH', url: '/api/users/not-a-uuid', headers: { cookie: admin.cookie }, payload: { blocked: true },
    });
    expect(r404.statusCode).toBe(404);
    expect(r400.statusCode).toBe(400);
  });

  it('понижённый админ получает 403 со старым cookie (роль берётся из БД)', async () => {
    const second = await loginAs(t, 'admin');
    const demote = await t.app.inject({
      method: 'PATCH', url: `/api/users/${second.user.id}`, headers: { cookie: admin.cookie }, payload: { role: 'user' },
    });
    expect(demote.statusCode).toBe(200);
    const res = await t.app.inject({ method: 'GET', url: '/api/users', headers: { cookie: second.cookie } });
    expect(res.statusCode).toBe(403);
  });
});
