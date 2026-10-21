import { randomUUID } from 'node:crypto';
import type { AccessTemplateRow, UserDirectoryEntry } from '@carbone-reports/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { templateEditors, templates, users } from '../src/db/schema';
import {
  createSourceDatabase,
  createTemplate,
  createTestApp,
  loginAs,
  type TestApp,
} from './helpers';

// Распорядитель доступа, редакторы и владелец шаблона, справочники (§43.2–§43.3).
let t: TestApp;
let admin: string;
let manager: { cookie: string; id: string };
let editorA: { cookie: string; id: string };
let editorB: { cookie: string; id: string };
let editorC: { cookie: string; id: string };
let user: { cookie: string; id: string };
let blockedEditorId: string;
let dsId: string;
/** Закрытый шаблон редактора A. */
let ownA: string;
/** Публичный шаблон администратора: виден всем по §19. */
let foreignPublic: string;
/** Закрытый шаблон администратора: редактору и распорядителю не виден. */
let foreignClosed: string;

const req = (
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  url: string,
  cookie: string,
  payload?: unknown,
) =>
  t.app.inject({
    method,
    url,
    headers: { cookie },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

const ACCESS = { public: false, categoryId: null, groupIds: [] };

beforeAll(async () => {
  t = await createTestApp();
  admin = (await loginAs(t, 'admin')).cookie;
  const m = await loginAs(t, 'access_manager');
  manager = { cookie: m.cookie, id: m.user.id };
  const a = await loginAs(t, 'editor');
  const b = await loginAs(t, 'editor');
  const c = await loginAs(t, 'editor');
  editorA = { cookie: a.cookie, id: a.user.id };
  editorB = { cookie: b.cookie, id: b.user.id };
  editorC = { cookie: c.cookie, id: c.user.id };
  const u = await loginAs(t, 'user');
  user = { cookie: u.cookie, id: u.user.id };
  const blocked = await loginAs(t, 'editor');
  blockedEditorId = blocked.user.id;
  await t.deps.db.update(users).set({ blocked: true }).where(eq(users.id, blockedEditorId));
  const src = await createSourceDatabase('select 1');
  dsId = (
    await req('POST', '/api/datasources', admin, { name: 'src', ...src, sslMode: 'disable' })
  ).json().id;
  ownA = await createTemplate(t, editorA.cookie, dsId);
  foreignPublic = await createTemplate(t, admin, dsId, { public: true });
  foreignClosed = await createTemplate(t, admin, dsId);
});
afterAll(() => t.close());

describe('распорядитель доступа', () => {
  it('ведёт группы', async () => {
    const g = await req('POST', '/api/groups', manager.cookie, { name: 'Группа РД' });
    expect(g.statusCode, g.body).toBe(201);
    const id = g.json().id as string;
    const p = await req('PATCH', `/api/groups/${id}`, manager.cookie, { name: 'Группа РД 2' });
    expect(p.statusCode, p.body).toBe(200);
    const mem = await req('PUT', `/api/groups/${id}/members`, manager.cookie, {
      userIds: [user.id],
    });
    expect(mem.statusCode, mem.body).toBe(200);
    expect(mem.json().memberIds).toEqual([user.id]);
    expect((await req('DELETE', `/api/groups/${id}`, manager.cookie)).statusCode).toBe(204);
  });

  it('ведёт категории и их группы', async () => {
    const g = (await req('POST', '/api/groups', manager.cookie, { name: 'Для категории' })).json();
    const c = await req('POST', '/api/categories', manager.cookie, { name: 'Категория РД' });
    expect(c.statusCode, c.body).toBe(201);
    const id = c.json().id as string;
    const p = await req('PATCH', `/api/categories/${id}`, manager.cookie, { name: 'Кат. РД' });
    expect(p.statusCode, p.body).toBe(200);
    const cg = await req('PUT', `/api/categories/${id}/groups`, manager.cookie, {
      groupIds: [g.id],
    });
    expect(cg.statusCode, cg.body).toBe(200);
    expect(cg.json().groupIds).toEqual([g.id]);
    expect((await req('DELETE', `/api/categories/${id}`, manager.cookie)).statusCode).toBe(204);
  });

  it('видит все шаблоны в /api/access/templates без содержимого', async () => {
    const r = await req('GET', '/api/access/templates', manager.cookie);
    expect(r.statusCode, r.body).toBe(200);
    const rows = r.json() as AccessTemplateRow[];
    expect(rows.map((x) => x.id)).toEqual(
      expect.arrayContaining([ownA, foreignPublic, foreignClosed]),
    );
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(['categoryId', 'groupIds', 'id', 'name', 'public']);
    }
    expect(rows.find((x) => x.id === foreignPublic)!.public).toBe(true);
  });

  it('читает и меняет доступ любого шаблона', async () => {
    const g = (await req('POST', '/api/groups', manager.cookie, { name: 'Доступ РД' })).json();
    const get = await req('GET', `/api/templates/${foreignClosed}/access`, manager.cookie);
    expect(get.statusCode, get.body).toBe(200);
    const put = await req('PUT', `/api/templates/${foreignClosed}/access`, manager.cookie, {
      ...ACCESS,
      groupIds: [g.id],
    });
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json()).toEqual({ ...ACCESS, groupIds: [g.id] });
    const rows = (await req('GET', '/api/access/templates', manager.cookie)).json();
    expect(rows.find((x: AccessTemplateRow) => x.id === foreignClosed).groupIds).toEqual([g.id]);
    // Вернуть как было: другие тесты считают шаблон закрытым.
    await req('PUT', `/api/templates/${foreignClosed}/access`, manager.cookie, ACCESS);
  });

  it('не видит содержимое шаблонов', async () => {
    expect((await req('GET', `/api/templates/${foreignClosed}`, manager.cookie)).statusCode).toBe(
      404,
    );
    const pub = await req('GET', `/api/templates/${foreignPublic}`, manager.cookie);
    expect(pub.statusCode, pub.body).toBe(200);
    expect(pub.json()).not.toHaveProperty('queries');
    const denied = [
      req('GET', `/api/templates/${foreignPublic}/download`, manager.cookie),
      req('PUT', `/api/templates/${foreignPublic}/queries`, manager.cookie, []),
      req('POST', `/api/templates/${foreignPublic}/preview`, manager.cookie, {
        params: {},
        mode: 'data',
      }),
      req(
        'GET',
        `/api/templates/${foreignPublic}/editor-config?holder=${randomUUID()}`,
        manager.cookie,
      ),
      req('POST', '/api/templates/export', manager.cookie, { ids: [foreignPublic] }),
    ];
    for (const r of await Promise.all(denied)) expect(r.statusCode, r.body).toBe(403);
  });

  it('не управляет пользователями и источниками, но видит справочник', async () => {
    expect((await req('GET', '/api/users', manager.cookie)).statusCode).toBe(403);
    expect((await req('GET', `/api/users/${user.id}/groups`, manager.cookie)).statusCode).toBe(403);
    expect((await req('GET', '/api/users/directory', manager.cookie)).statusCode).toBe(200);
    expect((await req('GET', '/api/datasources/options', manager.cookie)).statusCode).toBe(403);
  });
});

describe('редактор: справочники и доступ шаблона', () => {
  it('читает группы, категории, источники и справочник редакторов', async () => {
    expect((await req('GET', '/api/groups', editorA.cookie)).statusCode).toBe(200);
    expect((await req('GET', '/api/categories', editorA.cookie)).statusCode).toBe(200);
    const ds = await req('GET', '/api/datasources/options', editorA.cookie);
    expect(ds.statusCode, ds.body).toBe(200);
    expect(ds.json()).toEqual([{ id: dsId, name: 'src' }]);
    const dir = await req('GET', '/api/users/directory?role=editor', editorA.cookie);
    expect(dir.statusCode, dir.body).toBe(200);
    const entries = dir.json() as UserDirectoryEntry[];
    expect(entries.every((e) => e.role === 'editor')).toBe(true);
    expect(entries.map((e) => e.id)).toEqual(
      expect.arrayContaining([editorA.id, editorB.id, editorC.id]),
    );
    expect(Object.keys(entries[0]!).sort()).toEqual(['id', 'login', 'role']);
    const logins = entries.map((e) => e.login.toLowerCase());
    expect(logins).toEqual([...logins].sort());
  });

  it('не меняет группы и не видит источники целиком', async () => {
    expect((await req('POST', '/api/groups', editorA.cookie, { name: 'нельзя' })).statusCode).toBe(
      403,
    );
    expect((await req('GET', '/api/datasources', editorA.cookie)).statusCode).toBe(403);
  });

  it('меняет доступ только тех шаблонов, которые может править', async () => {
    const own = await req('PUT', `/api/templates/${ownA}/access`, editorA.cookie, ACCESS);
    expect(own.statusCode, own.body).toBe(200);
    expect((await req('GET', `/api/templates/${ownA}/access`, editorA.cookie)).statusCode).toBe(
      200,
    );
    const foreign = await req('PUT', `/api/templates/${foreignPublic}/access`, editorA.cookie, {
      ...ACCESS,
      public: true,
    });
    expect(foreign.statusCode, foreign.body).toBe(403);
    expect(foreign.json().error.message).toBe('нет права на правку шаблона');
    expect(
      (await req('GET', `/api/templates/${foreignPublic}/access`, editorA.cookie)).statusCode,
    ).toBe(403);
    const hidden = await req('PUT', `/api/templates/${foreignClosed}/access`, editorA.cookie, {
      ...ACCESS,
      public: true,
    });
    expect(hidden.statusCode, hidden.body).toBe(404);
    const [row] = await t.deps.db.select().from(templates).where(eq(templates.id, foreignClosed));
    expect(row!.public).toBe(false);
  });
});

describe('редакторы шаблона', () => {
  it('владелец выдаёт право правки, не меняя updatedAt', async () => {
    const [before] = await t.deps.db.select().from(templates).where(eq(templates.id, ownA));
    const r = await req('PUT', `/api/templates/${ownA}/editors`, editorA.cookie, {
      userIds: [editorB.id, editorB.id],
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ ownerId: editorA.id, userIds: [editorB.id] });
    const [after] = await t.deps.db.select().from(templates).where(eq(templates.id, ownA));
    expect(after!.updatedAt).toEqual(before!.updatedAt);
    expect(after!.updatedBy).toBe(before!.updatedBy);
    const g = await req('GET', `/api/templates/${ownA}/editors`, editorA.cookie);
    expect(g.json()).toEqual({ ownerId: editorA.id, userIds: [editorB.id] });
    // Выданный редактор теперь правит шаблон.
    expect((await req('GET', `/api/templates/${ownA}/access`, editorB.cookie)).statusCode).toBe(
      200,
    );
  });

  it('отказывает с понятным текстом', async () => {
    const cases: [string[], string][] = [
      [[user.id], 'можно выдать только пользователю с ролью «Редактор»'],
      [[editorA.id], 'владелец уже может править шаблон'],
      [['00000000-0000-4000-8000-000000000000'], 'пользователь не найден'],
    ];
    for (const [userIds, error] of cases) {
      const r = await req('PUT', `/api/templates/${ownA}/editors`, editorA.cookie, { userIds });
      expect(r.statusCode, r.body).toBe(400);
      expect(r.json().error.message).toBe(error);
    }
    const g = await req('GET', `/api/templates/${ownA}/editors`, editorA.cookie);
    expect(g.json().userIds).toEqual([editorB.id]);
  });

  it('выданный редактор не ведёт редакторов, администратор — ведёт', async () => {
    expect(
      (
        await req('PUT', `/api/templates/${ownA}/editors`, editorB.cookie, {
          userIds: [editorC.id],
        })
      ).statusCode,
    ).toBe(403);
    expect((await req('GET', `/api/templates/${ownA}/editors`, editorB.cookie)).statusCode).toBe(
      403,
    );
    const r = await req('PUT', `/api/templates/${ownA}/editors`, admin, {
      userIds: [editorC.id, editorB.id],
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({
      ownerId: editorA.id,
      userIds: [editorB.id, editorC.id].sort(),
    });
    expect((await req('GET', `/api/templates/${ownA}/editors`, admin)).statusCode).toBe(200);
  });
});

describe('редакторы шаблона: понижённые редакторы', () => {
  it('запись понижённого редактора не мешает сохранить список и остаётся', async () => {
    const owner = await loginAs(t, 'editor');
    const stale = await loginAs(t, 'editor');
    const fresh = await loginAs(t, 'editor');
    const id = await createTemplate(t, owner.cookie, dsId);
    const g = await req('PUT', `/api/templates/${id}/editors`, owner.cookie, {
      userIds: [stale.user.id],
    });
    expect(g.statusCode, g.body).toBe(200);
    await t.deps.db.update(users).set({ role: 'user' }).where(eq(users.id, stale.user.id));
    const r = await req('PUT', `/api/templates/${id}/editors`, owner.cookie, {
      userIds: [stale.user.id, fresh.user.id],
    });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().userIds).toEqual([stale.user.id, fresh.user.id].sort());
    // Новому — по-прежнему только с ролью «Редактор».
    const bad = await req('PUT', `/api/templates/${id}/editors`, owner.cookie, {
      userIds: [stale.user.id, fresh.user.id, user.id],
    });
    expect(bad.statusCode, bad.body).toBe(400);
    expect(bad.json().error.message).toBe('можно выдать только пользователю с ролью «Редактор»');
    // Убрать понижённого можно.
    const rm = await req('PUT', `/api/templates/${id}/editors`, owner.cookie, {
      userIds: [fresh.user.id],
    });
    expect(rm.statusCode, rm.body).toBe(200);
    expect(rm.json().userIds).toEqual([fresh.user.id]);
  });
});

/**
 * Держит строку шаблона FOR UPDATE, пока запрос не встанет в ожидание блокировки, затем меняет
 * владельца и отпускает: запрос продолжает уже с новым владельцем (гонка «смена владельца — PUT/DELETE»).
 */
async function changeOwnerWhileWaiting(
  templateId: string,
  newOwnerId: string,
  send: () => Promise<{ statusCode: number; body: string }>,
) {
  let pending!: Promise<{ statusCode: number; body: string }>;
  await t.deps.db.transaction(async (tx) => {
    await tx.select().from(templates).where(eq(templates.id, templateId)).for('update');
    pending = send();
    await expect
      .poll(
        async () =>
          (
            await t.deps.db.execute<{ n: number }>(
              sql`select count(*)::int as n from pg_stat_activity
                  where datname = current_database() and wait_event_type = 'Lock'`,
            )
          ).rows[0]!.n,
        { timeout: 5000, interval: 20 },
      )
      .toBeGreaterThan(0);
    await tx.update(templates).set({ ownerId: newOwnerId }).where(eq(templates.id, templateId));
  });
  return pending;
}

describe('смена владельца во время запроса прежнего владельца', () => {
  it('PUT …/editors прежнего владельца под блокировкой — 403, себя он не выдаёт', async () => {
    const a = await loginAs(t, 'editor');
    const c = await loginAs(t, 'editor');
    const id = await createTemplate(t, a.cookie, dsId);
    const r = await changeOwnerWhileWaiting(id, c.user.id, () =>
      req('PUT', `/api/templates/${id}/editors`, a.cookie, { userIds: [a.user.id] }),
    );
    expect(r.statusCode, r.body).toBe(403);
    const rows = await t.deps.db
      .select()
      .from(templateEditors)
      .where(eq(templateEditors.templateId, id));
    expect(rows).toEqual([]);
  });

  it('DELETE прежнего владельца под блокировкой — 403, шаблон на месте', async () => {
    const a = await loginAs(t, 'editor');
    const c = await loginAs(t, 'editor');
    const id = await createTemplate(t, a.cookie, dsId);
    const r = await changeOwnerWhileWaiting(id, c.user.id, () =>
      req('DELETE', `/api/templates/${id}`, a.cookie),
    );
    expect(r.statusCode, r.body).toBe(403);
    const [row] = await t.deps.db.select().from(templates).where(eq(templates.id, id));
    expect(row?.ownerId).toBe(c.user.id);
  });
});

describe('владелец шаблона', () => {
  it('сменить владельца может только администратор', async () => {
    const own = await req('PUT', `/api/templates/${ownA}/owner`, editorA.cookie, {
      userId: editorC.id,
    });
    expect(own.statusCode, own.body).toBe(403);
    const bad = await req('PUT', `/api/templates/${ownA}/owner`, admin, { userId: user.id });
    expect(bad.statusCode, bad.body).toBe(400);
    expect(bad.json().error.message).toBe(
      'владельцем может быть только пользователь с ролью «Редактор»',
    );
    const missing = await req('PUT', `/api/templates/${ownA}/owner`, admin, {
      userId: '00000000-0000-4000-8000-000000000000',
    });
    expect(missing.statusCode, missing.body).toBe(400);
    expect(missing.json().error.message).toBe('пользователь не найден');
  });

  it('новый владелец выходит из списка редакторов, прежний теряет право', async () => {
    const [before] = await t.deps.db.select().from(templates).where(eq(templates.id, ownA));
    const r = await req('PUT', `/api/templates/${ownA}/owner`, admin, { userId: editorC.id });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toEqual({ ownerId: editorC.id, userIds: [editorB.id] });
    const [after] = await t.deps.db.select().from(templates).where(eq(templates.id, ownA));
    expect(after!.updatedAt).toEqual(before!.updatedAt);
    expect([403, 404]).toContain(
      (await req('GET', `/api/templates/${ownA}/access`, editorA.cookie)).statusCode,
    );
    expect([403, 404]).toContain(
      (await req('PUT', `/api/templates/${ownA}/editors`, editorA.cookie, { userIds: [] }))
        .statusCode,
    );
    expect((await req('GET', `/api/templates/${ownA}/editors`, editorC.cookie)).statusCode).toBe(
      200,
    );
  });

  it('владелец несуществующего шаблона — 404', async () => {
    const r = await req('PUT', '/api/templates/00000000-0000-4000-8000-000000000000/owner', admin, {
      userId: editorC.id,
    });
    expect(r.statusCode, r.body).toBe(404);
  });
});

describe('обычный пользователь и справочник', () => {
  it('пользователю справочники закрыты', async () => {
    expect((await req('GET', '/api/users/directory', user.cookie)).statusCode).toBe(403);
    expect((await req('GET', '/api/groups', user.cookie)).statusCode).toBe(403);
    expect((await req('GET', '/api/categories', user.cookie)).statusCode).toBe(403);
    expect((await req('GET', '/api/access/templates', user.cookie)).statusCode).toBe(403);
    expect((await req('GET', '/api/datasources/options', user.cookie)).statusCode).toBe(403);
  });

  it('заблокированный пользователь не попадает в справочник', async () => {
    const all = (await req('GET', '/api/users/directory', admin)).json() as UserDirectoryEntry[];
    const ids = all.map((e) => e.id);
    expect(ids).not.toContain(blockedEditorId);
    expect(ids).toEqual(expect.arrayContaining([user.id, manager.id, editorA.id]));
    const editors = (
      await req('GET', '/api/users/directory?role=editor', admin)
    ).json() as UserDirectoryEntry[];
    expect(editors.map((e) => e.id)).not.toContain(blockedEditorId);
    expect(editors.map((e) => e.id)).not.toContain(user.id);
  });

  it('неизвестная роль в фильтре — 400', async () => {
    expect((await req('GET', '/api/users/directory?role=boss', admin)).statusCode).toBe(400);
  });
});
