import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { users } from '../src/db/schema';
import { ensureAdmin } from '../src/modules/auth/bootstrap';
import { createTestApp, loginAs, type TestApp } from './helpers';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

describe('auth', () => {
  it('ensureAdmin создаёт админа при пустой таблице и не дублирует', async () => {
    t.deps.config.adminLogin = 'root';
    t.deps.config.adminPassword = 'rootpass123';
    await ensureAdmin(t.deps);
    await ensureAdmin(t.deps);
    const rows = await t.deps.db.select().from(users).where(eq(users.login, 'root'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe('admin');
  });

  it('вход с верным паролем ставит httpOnly cookie, /me возвращает пользователя', async () => {
    const res = await t.app.inject({
      method: 'POST', url: '/api/auth/login', payload: { login: 'root', password: 'rootpass123' },
    });
    expect(res.statusCode).toBe(200);
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toMatch(/session=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    const cookie = setCookie.split(';')[0]!;
    const me = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.json()).toMatchObject({ login: 'root', role: 'admin' });
  });

  it('неверный пароль → 401 без подсказки, существует ли логин', async () => {
    const a = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'root', password: 'bad' } });
    const b = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login: 'nobody', password: 'bad' } });
    expect(a.statusCode).toBe(401);
    expect(b.statusCode).toBe(401);
    expect(a.json()).toEqual(b.json());
  });

  it('без cookie /me → 401', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(res.statusCode).toBe(401);
  });

  it('заблокированный пользователь теряет доступ с уже выданной cookie', async () => {
    const { cookie, user } = await loginAs(t, 'user');
    await t.deps.db.update(users).set({ blocked: true }).where(eq(users.id, user.id));
    const me = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(me.statusCode).toBe(401);
  });

  it('logout очищает cookie', async () => {
    const { cookie } = await loginAs(t, 'user');
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    expect(res.statusCode).toBe(204);
    expect(String(res.headers['set-cookie'])).toMatch(/session=;/);
  });

  it('11-я неудачная попытка входа за минуту для одного логина → 429, другие логины не затронуты', async () => {
    const { user } = await loginAs(t, 'user');
    const attempt = (login: string, password: string) =>
      t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { login, password } });
    // loginAs уже сделал 1 запрос; добиваем до лимита (10) неверными паролями.
    for (let i = 0; i < 9; i++) expect((await attempt(user.login, 'bad')).statusCode).toBe(401);
    const blocked = await attempt(user.login.toUpperCase(), 'bad');
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toEqual({
      error: { code: 'TOO_MANY_ATTEMPTS', message: 'слишком много попыток входа, повторите через минуту' },
    });
    const other = await loginAs(t, 'user');
    expect((await attempt(other.user.login, 'bad')).statusCode).toBe(401);
    expect((await attempt(other.user.login, 'password123')).statusCode).toBe(200);
  });

  it('пароль длиннее 1024 символов при входе → 400', async () => {
    const res = await t.app.inject({
      method: 'POST', url: '/api/auth/login', payload: { login: 'root', password: 'x'.repeat(1025) },
    });
    expect(res.statusCode).toBe(400);
  });
});
