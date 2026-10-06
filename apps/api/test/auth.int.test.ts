import { eq, sql } from 'drizzle-orm';
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
    await ensureAdmin(t.deps, { warn: () => {} });
    await ensureAdmin(t.deps, { warn: () => {} });
    const rows = await t.deps.db.select().from(users).where(eq(users.login, 'root'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.role).toBe('admin');
  });

  it('ensureAdmin предупреждает, если пользователей нет и админ не задан', async () => {
    const t2 = await createTestApp();
    try {
      const warns: string[] = [];
      await ensureAdmin(t2.deps, { warn: (m) => void warns.push(m) });
      expect(warns).toHaveLength(1);
      expect(warns[0]).toMatch(/ADMIN_LOGIN/);
    } finally {
      await t2.close();
    }
  });

  it('вход с верным паролем ставит httpOnly cookie, /me возвращает пользователя', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { login: 'root', password: 'rootpass123' },
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
    const a = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { login: 'root', password: 'bad' },
    });
    const b = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { login: 'nobody', password: 'bad' },
    });
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
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie },
    });
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
      error: {
        code: 'TOO_MANY_ATTEMPTS',
        message: 'слишком много попыток входа, повторите через минуту',
      },
    });
    const other = await loginAs(t, 'user');
    expect((await attempt(other.user.login, 'bad')).statusCode).toBe(401);
    expect((await attempt(other.user.login, 'password123')).statusCode).toBe(200);
  });

  it('пароль длиннее 1024 символов при входе → 400', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { login: 'root', password: 'x'.repeat(1025) },
    });
    expect(res.statusCode).toBe(400);
  });

  it('логин длиннее 256 символов → 400 VALIDATION до лимита попыток', async () => {
    const login = 'a'.repeat(300);
    // 11 запросов: если бы лимит попыток срабатывал раньше проверки схемы, последний дал бы 429.
    for (let i = 0; i < 11; i++) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { login, password: 'bad' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION');
    }
  });
});

describe('отзыв сессий', () => {
  const me = (cookie: string) =>
    t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });

  it('смена пароля админом завершает все сессии пользователя', async () => {
    const admin = await loginAs(t, 'admin');
    const u = await loginAs(t, 'user');
    expect((await me(u.cookie)).statusCode).toBe(200);
    const r = await t.app.inject({
      method: 'PATCH',
      url: `/api/users/${u.user.id}`,
      headers: { cookie: admin.cookie },
      payload: { password: 'new-password-1' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers['set-cookie']).toBeUndefined();
    expect((await me(u.cookie)).statusCode).toBe(401);
  });

  it('смена роли завершает сессии', async () => {
    const admin = await loginAs(t, 'admin');
    const u = await loginAs(t, 'user');
    await t.app.inject({
      method: 'PATCH',
      url: `/api/users/${u.user.id}`,
      headers: { cookie: admin.cookie },
      payload: { role: 'admin' },
    });
    expect((await me(u.cookie)).statusCode).toBe(401);
  });

  it('админ меняет собственный пароль: текущая сессия продолжается по новой cookie, старая cookie недействительна', async () => {
    const admin = await loginAs(t, 'admin');
    const r = await t.app.inject({
      method: 'PATCH',
      url: `/api/users/${admin.user.id}`,
      headers: { cookie: admin.cookie },
      payload: { password: 'new-password-2' },
    });
    expect(r.statusCode).toBe(200);
    const fresh = String(r.headers['set-cookie']).split(';')[0]!;
    expect(fresh).toMatch(/^session=/);
    expect((await me(fresh)).statusCode).toBe(200);
    expect((await me(admin.cookie)).statusCode).toBe(401);
  });

  it('самоправка со старой cookie после отзыва: 401, без set-cookie, пароль не изменён', async () => {
    const admin = await loginAs(t, 'admin');
    await t.deps.db
      .update(users)
      .set({ sessionVersion: sql`${users.sessionVersion} + 1` })
      .where(eq(users.id, admin.user.id));
    const r = await t.app.inject({
      method: 'PATCH',
      url: `/api/users/${admin.user.id}`,
      headers: { cookie: admin.cookie },
      payload: { password: 'new-password-3' },
    });
    expect(r.statusCode).toBe(401);
    expect(r.headers['set-cookie']).toBeUndefined();
    const login = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { login: admin.user.login, password: 'password123' },
    });
    expect(login.statusCode).toBe(200);
  });

  it('admin завершает сессии пользователя; свои — нельзя; несуществующий — 404', async () => {
    const admin = await loginAs(t, 'admin');
    const u = await loginAs(t, 'user');
    const revoke = (id: string) =>
      t.app.inject({
        method: 'POST',
        url: `/api/users/${id}/sessions/revoke`,
        headers: { cookie: admin.cookie },
      });
    expect((await revoke(u.user.id)).statusCode).toBe(204);
    expect((await me(u.cookie)).statusCode).toBe(401);
    expect((await revoke(admin.user.id)).statusCode).toBe(400);
    expect((await revoke('00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
  });

  it('user не может завершать чужие сессии', async () => {
    const u = await loginAs(t, 'user');
    const v = await loginAs(t, 'user');
    const r = await t.app.inject({
      method: 'POST',
      url: `/api/users/${v.user.id}/sessions/revoke`,
      headers: { cookie: u.cookie },
    });
    expect(r.statusCode).toBe(403);
  });

  it('«Выйти везде» завершает все сессии текущего пользователя и очищает cookie', async () => {
    const u = await loginAs(t, 'user');
    const r = await t.app.inject({
      method: 'POST',
      url: '/api/auth/logout-all',
      headers: { cookie: u.cookie },
    });
    expect(r.statusCode).toBe(204);
    expect(String(r.headers['set-cookie'])).toMatch(/session=;/);
    expect((await me(u.cookie)).statusCode).toBe(401);
  });

  it('cookie без sv (выпущенная до обновления) недействительна', async () => {
    const u = await loginAs(t, 'user');
    const { SignJWT } = await import('jose');
    const legacy = await new SignJWT({ login: u.user.login, role: u.user.role })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(u.user.id)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(t.deps.config.appSecret);
    expect((await me(`session=${legacy}`)).statusCode).toBe(401);
  });
});
