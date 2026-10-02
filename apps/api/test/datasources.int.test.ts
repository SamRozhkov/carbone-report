import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSourceDatabase, createTestApp, loginAs, type SourceConn, type TestApp } from './helpers';

let t: TestApp;
let admin: string;
let user: string;
let src: SourceConn;
beforeAll(async () => {
  t = await createTestApp();
  admin = (await loginAs(t, 'admin')).cookie;
  user = (await loginAs(t, 'user')).cookie;
  src = await createSourceDatabase('create table items(id int, price numeric, d date); insert into items values (1, 9.5, \'2026-01-31\');');
});
afterAll(() => t.close());

const body = () => ({ name: 'Склад', ...src, ssl: false });

describe('datasources', () => {
  it('user → 403', async () => {
    const r = await t.app.inject({ method: 'GET', url: '/api/datasources', headers: { cookie: user } });
    expect(r.statusCode).toBe(403);
  });

  it('создание без пароля → 400', async () => {
    const { password: _, ...noPass } = body();
    const r = await t.app.inject({ method: 'POST', url: '/api/datasources', headers: { cookie: admin }, payload: noPass });
    expect(r.statusCode).toBe(400);
  });

  it('создание, пароль не возвращается и хранится зашифрованным', async () => {
    const r = await t.app.inject({ method: 'POST', url: '/api/datasources', headers: { cookie: admin }, payload: body() });
    expect(r.statusCode).toBe(201);
    expect(r.json()).not.toHaveProperty('password');
    expect(r.json()).not.toHaveProperty('passwordEnc');
    const list = await t.app.inject({ method: 'GET', url: '/api/datasources', headers: { cookie: admin } });
    // Пароль контейнера совпадает с логином ('test'), поэтому проверяем ключи, а не подстроку.
    for (const item of list.json()) {
      expect(item).not.toHaveProperty('password');
      expect(item).not.toHaveProperty('passwordEnc');
    }
  });

  it('проверка соединения: успешная и с неверным паролем', async () => {
    const ok = await t.app.inject({ method: 'POST', url: '/api/datasources/test', headers: { cookie: admin }, payload: body() });
    expect(ok.json()).toEqual({ ok: true });
    const bad = await t.app.inject({
      method: 'POST', url: '/api/datasources/test', headers: { cookie: admin }, payload: { ...body(), password: 'wrong' },
    });
    expect(bad.json().ok).toBe(false);
    expect(bad.json().message).toMatch(/password|парол/i);
  });

  it('пул применяет парсеры типов: numeric → number, date → строка', async () => {
    const created = await t.app.inject({ method: 'POST', url: '/api/datasources', headers: { cookie: admin }, payload: body() });
    const { pool } = await t.deps.sources.get(created.json().id);
    const r = await pool.query('select price, d from items');
    expect(r.rows[0]).toEqual({ price: 9.5, d: '2026-01-31' });
  });

  it('bigint за пределами 2^53 остаётся строкой без потери точности', async () => {
    const created = await t.app.inject({ method: 'POST', url: '/api/datasources', headers: { cookie: admin }, payload: body() });
    const { pool } = await t.deps.sources.get(created.json().id);
    const r = await pool.query("select 9007199254740993::int8 as big, 42::int8 as small, 12345678901234567890.5::numeric as huge");
    expect(r.rows[0]).toEqual({ big: '9007199254740993', small: 42, huge: '12345678901234567890.5' });
  });

  it('PATCH без пароля сохраняет старый пароль, проверка по id проходит', async () => {
    const created = await t.app.inject({ method: 'POST', url: '/api/datasources', headers: { cookie: admin }, payload: body() });
    const id = created.json().id;
    const { password: _, ...noPass } = body();
    const upd = await t.app.inject({
      method: 'PATCH', url: `/api/datasources/${id}`, headers: { cookie: admin }, payload: { ...noPass, name: 'Склад 2' },
    });
    expect(upd.json().name).toBe('Склад 2');
    const test = await t.app.inject({ method: 'POST', url: `/api/datasources/${id}/test`, headers: { cookie: admin } });
    expect(test.json()).toEqual({ ok: true });
  });

  it('PATCH с новым паролем сбрасывает закэшированный пул', async () => {
    const created = await t.app.inject({ method: 'POST', url: '/api/datasources', headers: { cookie: admin }, payload: body() });
    const id = created.json().id;
    await t.deps.sources.get(id);
    await t.app.inject({
      method: 'PATCH', url: `/api/datasources/${id}`, headers: { cookie: admin }, payload: { ...body(), password: 'wrong' },
    });
    const test = await t.app.inject({ method: 'POST', url: `/api/datasources/${id}/test`, headers: { cookie: admin } });
    expect(test.json().ok).toBe(false);
  });

  it('удаление несуществующего → 404', async () => {
    const r = await t.app.inject({
      method: 'DELETE', url: '/api/datasources/00000000-0000-0000-0000-000000000000', headers: { cookie: admin },
    });
    expect(r.statusCode).toBe(404);
  });
});
