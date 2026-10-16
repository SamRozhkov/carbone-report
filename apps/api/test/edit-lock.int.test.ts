import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { templateEditLocks, users } from '../src/db/schema';
import {
  createSourceDatabase,
  createTemplate,
  createTestApp,
  loginAs,
  type TestApp,
} from './helpers';

let t: TestApp;
let a: { cookie: string; id: string; login: string };
let b: { cookie: string; id: string; login: string };
let user: string;
let dsId: string;
let tplId: string;
const forceSaved: string[] = [];
let forceSaveError: Error | null = null;

async function admin() {
  const r = await loginAs(t, 'admin');
  return { cookie: r.cookie, id: r.user.id, login: r.user.login };
}
const lock = (cookie: string, holder: string, acquire = true, id = tplId) =>
  t.app.inject({
    method: 'POST',
    url: `/api/templates/${id}/edit-lock`,
    headers: { cookie },
    payload: { holder, acquire },
  });
const takeover = (cookie: string, holder: string) =>
  t.app.inject({
    method: 'POST',
    url: `/api/templates/${tplId}/edit-lock/takeover`,
    headers: { cookie },
    payload: { holder },
  });
const release = (cookie: string, holder: string) =>
  t.app.inject({
    method: 'DELETE',
    url: `/api/templates/${tplId}/edit-lock?holder=${holder}`,
    headers: { cookie },
  });
/** Сдвигает продление в прошлое — блокировка просрочена. */
const expire = () =>
  t.deps.db
    .update(templateEditLocks)
    .set({ heartbeatAt: sql`now() - interval '61 seconds'` })
    .where(eq(templateEditLocks.templateId, tplId));

beforeAll(async () => {
  t = await createTestApp({
    onlyoffice: {
      forceSave: async (key) => {
        forceSaved.push(key);
        if (forceSaveError) throw forceSaveError;
      },
    },
  });
  a = await admin();
  b = await admin();
  user = (await loginAs(t, 'user')).cookie;
  const src = await createSourceDatabase('select 1');
  const ds = await t.app.inject({
    method: 'POST',
    url: '/api/datasources',
    headers: { cookie: a.cookie },
    payload: { name: `ds-${randomUUID().slice(0, 6)}`, ...src, sslMode: 'disable' },
  });
  dsId = ds.json().id;
});
afterAll(() => t.close());
beforeEach(async () => {
  tplId = await createTemplate(t, a.cookie, dsId);
  forceSaved.length = 0;
  forceSaveError = null;
});

describe('edit-lock', () => {
  it('захват свободного, продление своим holder, чужой видит other', async () => {
    const ha = randomUUID();
    expect((await lock(a.cookie, ha)).json()).toEqual({ state: 'mine' });
    expect((await lock(a.cookie, ha)).json()).toEqual({ state: 'mine' });
    const r = await lock(b.cookie, randomUUID());
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      state: 'other',
      user: { id: a.id, login: a.login },
      sameUser: false,
    });
    expect(Date.parse(r.json().since)).not.toBeNaN();
  });

  it('вторая вкладка того же администратора — sameUser', async () => {
    await lock(a.cookie, randomUUID());
    expect((await lock(a.cookie, randomUUID())).json()).toMatchObject({
      state: 'other',
      sameUser: true,
    });
  });

  it('acquire: false — только чтение: free, other; свою продлевает', async () => {
    const ha = randomUUID();
    expect((await lock(a.cookie, ha, false)).json()).toEqual({ state: 'free' });
    const [none] = await t.deps.db
      .select()
      .from(templateEditLocks)
      .where(eq(templateEditLocks.templateId, tplId));
    expect(none).toBeUndefined();
    await lock(a.cookie, ha);
    expect((await lock(b.cookie, randomUUID(), false)).json()).toMatchObject({ state: 'other' });
    expect((await lock(a.cookie, ha, false)).json()).toEqual({ state: 'mine' });
  });

  it('просроченная блокировка свободна: захват другим, acquired_at обновлён', async () => {
    const ha = randomUUID();
    await lock(a.cookie, ha);
    await expire();
    expect((await lock(b.cookie, randomUUID(), false)).json()).toEqual({ state: 'free' });
    const hb = randomUUID();
    expect((await lock(b.cookie, hb)).json()).toEqual({ state: 'mine' });
    expect((await lock(a.cookie, ha)).json()).toMatchObject({
      state: 'other',
      user: { id: b.id },
    });
  });

  it('продление своим holder не меняет acquired_at', async () => {
    const ha = randomUUID();
    await lock(a.cookie, ha);
    const [r1] = await t.deps.db
      .select()
      .from(templateEditLocks)
      .where(eq(templateEditLocks.templateId, tplId));
    await new Promise((r) => setTimeout(r, 20));
    await lock(a.cookie, ha);
    const [r2] = await t.deps.db
      .select()
      .from(templateEditLocks)
      .where(eq(templateEditLocks.templateId, tplId));
    expect(r2!.acquiredAt.getTime()).toBe(r1!.acquiredAt.getTime());
    expect(r2!.heartbeatAt.getTime()).toBeGreaterThanOrEqual(r1!.heartbeatAt.getTime());
  });

  it('гонка: из 10 одновременных захватов ровно один mine', async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => lock(i % 2 ? a.cookie : b.cookie, randomUUID())),
    );
    const states = results.map((r) => r.json().state);
    expect(states.filter((s) => s === 'mine')).toHaveLength(1);
    expect(states.filter((s) => s === 'other')).toHaveLength(9);
  });

  it('перехват: блокировка переходит, forcesave ключа документа, прежний видит other', async () => {
    const ha = randomUUID();
    await lock(a.cookie, ha);
    const hb = randomUUID();
    const r = await takeover(b.cookie, hb);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ state: 'mine' });
    expect(forceSaved).toHaveLength(1);
    expect((await lock(a.cookie, ha)).json()).toMatchObject({ state: 'other', user: { id: b.id } });
  });

  it('перехват свободного или своего — без forcesave', async () => {
    const hb = randomUUID();
    await takeover(b.cookie, hb);
    await takeover(b.cookie, hb);
    await lock(a.cookie, randomUUID()); // other — ничего не меняет
    await expire();
    await takeover(a.cookie, randomUUID());
    expect(forceSaved).toHaveLength(0);
  });

  it('ошибка forcesave (сервер недоступен, нет изменений) не мешает перехвату', async () => {
    await lock(a.cookie, randomUUID());
    forceSaveError = Object.assign(new Error('сервер документов недоступен'), { statusCode: 502 });
    const r = await takeover(b.cookie, randomUUID());
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ state: 'mine' });
  });

  it('освобождение: только своим holder, всегда 204', async () => {
    const ha = randomUUID();
    await lock(a.cookie, ha);
    expect((await release(b.cookie, randomUUID())).statusCode).toBe(204);
    expect((await lock(b.cookie, randomUUID(), false)).json()).toMatchObject({ state: 'other' });
    expect((await release(a.cookie, ha)).statusCode).toBe(204);
    expect((await lock(b.cookie, randomUUID(), false)).json()).toEqual({ state: 'free' });
  });

  it('проверки: holder не UUID — 400, не администратор — 403, нет шаблона — 404', async () => {
    expect((await lock(a.cookie, 'not-uuid')).statusCode).toBe(400);
    expect((await lock(user, randomUUID())).statusCode).toBe(403);
    expect((await lock(a.cookie, randomUUID(), true, randomUUID())).statusCode).toBe(404);
    expect(
      (
        await t.app.inject({
          method: 'DELETE',
          url: `/api/templates/${tplId}/edit-lock?holder=x`,
          headers: { cookie: a.cookie },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('удаление пользователя снимает его блокировку', async () => {
    const c = await admin();
    await lock(c.cookie, randomUUID());
    await t.deps.db.delete(users).where(eq(users.id, c.id));
    expect((await lock(a.cookie, randomUUID(), false)).json()).toEqual({ state: 'free' });
  });
});
