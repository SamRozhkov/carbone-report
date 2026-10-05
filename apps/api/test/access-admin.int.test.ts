import type {
  CategoryDto,
  GroupDto,
  TemplateAccess,
  TemplateSummary,
  UserDto,
} from '@carbone-reports/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { templateGroups, templates, userGroups } from '../src/db/schema';
import {
  createSourceDatabase,
  createTemplate,
  createTestApp,
  loginAs,
  type TestApp,
} from './helpers';

let t: TestApp;
let admin: string;
let userCookie: string;
let userId: string;
let dsId: string;
const NIL = '00000000-0000-4000-8000-000000000000';

const call = (
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  cookie: string,
  payload?: unknown,
) => t.app.inject({ method, url, headers: { cookie }, payload: payload as object | undefined });

const mkGroup = async (name: string) => {
  const r = await call('POST', '/api/groups', admin, { name, description: '' });
  expect(r.statusCode, r.body).toBe(201);
  return r.json() as GroupDto;
};
const mkCategory = async (name: string, extra: object = {}) => {
  const r = await call('POST', '/api/categories', admin, {
    name,
    sortOrder: 0,
    public: false,
    ...extra,
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json() as CategoryDto;
};
const visible = async (cookie: string) =>
  ((await call('GET', '/api/templates', cookie)).json() as TemplateSummary[]).map((s) => s.id);

beforeAll(async () => {
  t = await createTestApp();
  admin = (await loginAs(t, 'admin')).cookie;
  const u = await loginAs(t, 'user');
  userCookie = u.cookie;
  userId = u.user.id;
  const src = await createSourceDatabase('create table x(id int);');
  const ds = await call('POST', '/api/datasources', admin, {
    name: 'src',
    ...src,
    sslMode: 'disable',
  });
  dsId = ds.json().id;
});
afterAll(() => t.close());

describe('группы', () => {
  it('CRUD, дубликат без учёта регистра, пустое название, каскад связей', async () => {
    const g = await mkGroup('Продажи');
    expect(g.memberIds).toEqual([]);
    const dup = await call('POST', '/api/groups', admin, { name: 'ПРОДАЖИ', description: '' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.message).toBe('группа с таким названием уже существует');
    expect(
      (await call('POST', '/api/groups', admin, { name: '  ', description: '' })).statusCode,
    ).toBe(400);

    const other = await mkGroup('Финансы');
    const clash = await call('PATCH', `/api/groups/${other.id}`, admin, {
      name: 'продажи',
      description: '',
    });
    expect(clash.statusCode).toBe(409);
    const ren = await call('PATCH', `/api/groups/${g.id}`, admin, {
      name: 'Сбыт',
      description: 'd',
    });
    expect(ren.statusCode).toBe(200);
    expect(ren.json()).toMatchObject({ name: 'Сбыт', description: 'd' });
    expect(
      (await call('PATCH', `/api/groups/${NIL}`, admin, { name: 'x', description: '' })).statusCode,
    ).toBe(404);

    const list = (await call('GET', '/api/groups', admin)).json() as GroupDto[];
    const names = list.map((x) => x.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'ru')));

    const tid = await createTemplate(t, admin, dsId);
    await call('PUT', `/api/groups/${g.id}/members`, admin, { userIds: [userId] });
    await call('PUT', `/api/templates/${tid}/access`, admin, {
      public: false,
      categoryId: null,
      groupIds: [g.id],
    });
    expect(
      await t.deps.db.select().from(userGroups).where(eq(userGroups.groupId, g.id)),
    ).toHaveLength(1);
    expect(
      await t.deps.db.select().from(templateGroups).where(eq(templateGroups.groupId, g.id)),
    ).toHaveLength(1);

    expect((await call('DELETE', `/api/groups/${g.id}`, admin)).statusCode).toBe(204);
    expect(
      await t.deps.db.select().from(userGroups).where(eq(userGroups.groupId, g.id)),
    ).toHaveLength(0);
    expect(
      await t.deps.db.select().from(templateGroups).where(eq(templateGroups.groupId, g.id)),
    ).toHaveLength(0);
    expect((await call('DELETE', `/api/groups/${g.id}`, admin)).statusCode).toBe(404);
  });

  it('PUT members: неизвестный пользователь → 400, иначе состав заменяется', async () => {
    const g = await mkGroup('Состав');
    const second = await loginAs(t, 'user');
    const bad = await call('PUT', `/api/groups/${g.id}/members`, admin, { userIds: [userId, NIL] });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toBe('неизвестный пользователь');
    expect(
      (await call('GET', '/api/groups', admin)).json().find((x: GroupDto) => x.id === g.id)
        .memberIds,
    ).toEqual([]);

    const ok = await call('PUT', `/api/groups/${g.id}/members`, admin, {
      userIds: [userId, userId],
    });
    expect(ok.json().memberIds).toEqual([userId]);
    const swap = await call('PUT', `/api/groups/${g.id}/members`, admin, {
      userIds: [second.user.id],
    });
    expect(swap.json().memberIds).toEqual([second.user.id]);
    expect(
      (await call('PUT', `/api/groups/${NIL}/members`, admin, { userIds: [] })).statusCode,
    ).toBe(404);
  });
});

describe('категории', () => {
  it('CRUD, порядок, templateCount, удаление отвязывает шаблоны и закрывает доступ', async () => {
    const g = await mkGroup('Кат-группа');
    await call('PUT', `/api/groups/${g.id}/members`, admin, { userIds: [userId] });
    const b = await mkCategory('Бета', { sortOrder: 2 });
    const a = await mkCategory('Альфа', { sortOrder: 2 });
    const first = await mkCategory('Первая', { sortOrder: 1 });
    expect(
      (await call('POST', '/api/categories', admin, { name: 'АЛЬФА', sortOrder: 0, public: false }))
        .statusCode,
    ).toBe(409);
    expect(
      (await call('POST', '/api/categories', admin, { name: '', sortOrder: 0, public: false }))
        .statusCode,
    ).toBe(400);

    const ren = await call('PATCH', `/api/categories/${b.id}`, admin, {
      name: 'Гамма',
      sortOrder: 3,
      public: false,
    });
    expect(ren.json()).toMatchObject({ name: 'Гамма', sortOrder: 3 });
    const list = (await call('GET', '/api/categories', admin)).json() as CategoryDto[];
    expect(list.map((c) => c.id)).toEqual([first.id, a.id, b.id]);

    const withG = await call('PUT', `/api/categories/${a.id}/groups`, admin, { groupIds: [g.id] });
    expect(withG.json().groupIds).toEqual([g.id]);
    expect(
      (await call('PUT', `/api/categories/${a.id}/groups`, admin, { groupIds: [NIL] })).statusCode,
    ).toBe(400);

    const tid = await createTemplate(t, admin, dsId);
    await call('PUT', `/api/templates/${tid}/access`, admin, {
      public: false,
      categoryId: a.id,
      groupIds: [],
    });
    expect(await visible(userCookie)).toContain(tid);
    const counted = (await call('GET', '/api/categories', admin)).json() as CategoryDto[];
    expect(counted.find((c) => c.id === a.id)!.templateCount).toBe(1);
    expect(counted.find((c) => c.id === first.id)!.templateCount).toBe(0);

    expect((await call('DELETE', `/api/categories/${a.id}`, admin)).statusCode).toBe(204);
    const [row] = await t.deps.db.select().from(templates).where(eq(templates.id, tid));
    expect(row).toBeDefined();
    expect(row!.categoryId).toBeNull();
    expect(await visible(userCookie)).not.toContain(tid);
    expect((await call('DELETE', `/api/categories/${a.id}`, admin)).statusCode).toBe(404);
  });
});

describe('доступ к шаблону', () => {
  it('валидация, сохранение и открытие группе', async () => {
    const g = await mkGroup('Доступ');
    const c = await mkCategory('Для доступа');
    const tid = await createTemplate(t, admin, dsId);
    const url = `/api/templates/${tid}/access`;
    expect((await call('GET', url, admin)).json()).toEqual({
      public: false,
      categoryId: null,
      groupIds: [],
    });

    expect(
      (await call('PUT', url, admin, { public: false, categoryId: NIL, groupIds: [] })).statusCode,
    ).toBe(400);
    expect(
      (await call('PUT', url, admin, { public: false, categoryId: null, groupIds: [NIL] }))
        .statusCode,
    ).toBe(400);
    expect((await call('GET', url, admin)).json().groupIds).toEqual([]);

    expect(await visible(userCookie)).not.toContain(tid);
    const body: TemplateAccess = { public: false, categoryId: c.id, groupIds: [g.id] };
    const put = await call('PUT', url, admin, body);
    expect(put.statusCode, put.body).toBe(200);
    expect(put.json()).toEqual(body);
    expect((await call('GET', url, admin)).json()).toEqual(body);
    expect(await visible(userCookie)).not.toContain(tid);

    await call('PUT', `/api/groups/${g.id}/members`, admin, { userIds: [userId] });
    expect(await visible(userCookie)).toContain(tid);
    expect((await call('GET', `/api/templates/${NIL}/access`, admin)).statusCode).toBe(404);
    expect((await call('PUT', `/api/templates/${NIL}/access`, admin, body)).statusCode).toBe(404);
  });
});

describe('группы пользователя', () => {
  it('PUT заменяет группы, GET /api/users отдаёт groupIds', async () => {
    const g1 = await mkGroup('У1');
    const g2 = await mkGroup('У2');
    const put = await call('PUT', `/api/users/${userId}/groups`, admin, {
      groupIds: [g1.id, g2.id],
    });
    expect(put.statusCode).toBe(200);
    expect((put.json() as string[]).sort()).toEqual([g1.id, g2.id].sort());
    const swap = await call('PUT', `/api/users/${userId}/groups`, admin, { groupIds: [g2.id] });
    expect(swap.json()).toEqual([g2.id]);
    expect((await call('GET', `/api/users/${userId}/groups`, admin)).json()).toEqual([g2.id]);
    expect(
      (await call('PUT', `/api/users/${userId}/groups`, admin, { groupIds: [NIL] })).statusCode,
    ).toBe(400);
    expect(
      (await call('PUT', `/api/users/${NIL}/groups`, admin, { groupIds: [] })).statusCode,
    ).toBe(404);
    expect((await call('GET', `/api/users/${NIL}/groups`, admin)).statusCode).toBe(404);
    const users = (await call('GET', '/api/users', admin)).json() as UserDto[];
    expect(users.find((u) => u.id === userId)!.groupIds).toEqual([g2.id]);
    expect(users.find((u) => u.id !== userId)!.groupIds).toEqual([]);
  });
});

describe('роль user', () => {
  it('все новые маршруты → 403', async () => {
    const body = { name: 'x', description: '' };
    const access = { public: false, categoryId: null, groupIds: [] };
    const routes: Array<['GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', string, unknown?]> = [
      ['GET', '/api/groups'],
      ['POST', '/api/groups', body],
      ['PATCH', `/api/groups/${NIL}`, body],
      ['DELETE', `/api/groups/${NIL}`],
      ['PUT', `/api/groups/${NIL}/members`, { userIds: [] }],
      ['GET', '/api/categories'],
      ['POST', '/api/categories', { name: 'x', sortOrder: 0, public: false }],
      ['PATCH', `/api/categories/${NIL}`, { name: 'x', sortOrder: 0, public: false }],
      ['DELETE', `/api/categories/${NIL}`],
      ['PUT', `/api/categories/${NIL}/groups`, { groupIds: [] }],
      ['GET', `/api/templates/${NIL}/access`],
      ['PUT', `/api/templates/${NIL}/access`, access],
      ['GET', `/api/users/${NIL}/groups`],
      ['PUT', `/api/users/${NIL}/groups`, { groupIds: [] }],
    ];
    for (const [m, url, p] of routes) {
      const r = await call(m, url, userCookie, p);
      expect(r.statusCode, `${m} ${url}`).toBe(403);
    }
  });
});
