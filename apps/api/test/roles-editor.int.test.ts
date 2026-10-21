import { randomUUID } from 'node:crypto';
import type { TemplateEditSummary } from '@carbone-reports/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { templateEditors, templates } from '../src/db/schema';
import type { CarboneRenderer } from '../src/deps';
import { createBlankDocument } from '../src/modules/templates/blank';
import {
  createSourceDatabase,
  createTemplate,
  createTestApp,
  loginAs,
  multipart,
  type TestApp,
} from './helpers';

// Конструктор шаблонов для роли «Редактор» (§43.1–§43.3).
let t: TestApp;
let admin: string;
let editorA: { cookie: string; id: string; login: string };
let editorB: { cookie: string; id: string };
let editorC: { cookie: string; id: string };
let user: string;
let dsId: string;
/** Закрытый шаблон A (создан через POST /api/templates). */
let ownA: string;
/** Шаблон A, загруженный файлом. */
let uploadedA: string;
/** Закрытый шаблон администратора. */
let foreignClosed: string;
/** Публичный шаблон администратора. */
let foreignPublic: string;

const carbone: CarboneRenderer = {
  async render(_tpl, data) {
    return Buffer.from(JSON.stringify(data));
  },
};

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

const QUERY = { key: 'rows', mode: 'list', sql: 'select 1 as n' };

beforeAll(async () => {
  t = await createTestApp({ carbone });
  admin = (await loginAs(t, 'admin')).cookie;
  const a = await loginAs(t, 'editor');
  const b = await loginAs(t, 'editor');
  const c = await loginAs(t, 'editor');
  editorA = { cookie: a.cookie, id: a.user.id, login: a.user.login };
  editorB = { cookie: b.cookie, id: b.user.id };
  editorC = { cookie: c.cookie, id: c.user.id };
  user = (await loginAs(t, 'user')).cookie;
  const src = await createSourceDatabase('select 1');
  dsId = (
    await req('POST', '/api/datasources', admin, { name: 'src', ...src, sslMode: 'disable' })
  ).json().id;
  foreignClosed = await createTemplate(t, admin, dsId);
  foreignPublic = await createTemplate(t, admin, dsId, { public: true });
});
afterAll(() => t.close());

describe('редактор в конструкторе шаблонов', () => {
  it('создаёт шаблон и становится владельцем', async () => {
    const r = await req('POST', '/api/templates', editorA.cookie, {
      name: 'Шаблон A',
      datasourceId: dsId,
      blank: 'docx',
    });
    expect(r.statusCode, r.body).toBe(201);
    ownA = r.json().id;
    const d = await req('GET', `/api/templates/${ownA}`, editorA.cookie);
    expect(d.statusCode, d.body).toBe(200);
    expect(d.json()).toMatchObject({
      ownerId: editorA.id,
      canDelete: true,
      canManageEditors: true,
    });
  });

  it('загружает файл шаблона и становится владельцем', async () => {
    const mp = multipart(
      { name: 'Загруженный A', datasourceId: dsId },
      { name: 'a.docx', data: await createBlankDocument('docx') },
    );
    const r = await t.app.inject({
      method: 'POST',
      url: '/api/templates/upload',
      headers: { cookie: editorA.cookie, ...mp.headers },
      payload: mp.payload,
    });
    expect(r.statusCode, r.body).toBe(201);
    uploadedA = r.json().id;
    const [row] = await t.deps.db.select().from(templates).where(eq(templates.id, uploadedA));
    expect(row!.ownerId).toBe(editorA.id);
  });

  it('пользователь не создаёт шаблоны', async () => {
    const r = await req('POST', '/api/templates', user, {
      name: 'x',
      datasourceId: dsId,
      blank: 'docx',
    });
    expect(r.statusCode).toBe(403);
  });

  it('список scope=edit: свои и выданные шаблоны', async () => {
    const ids = async (cookie: string) => {
      const r = await req('GET', '/api/templates?scope=edit', cookie);
      expect(r.statusCode, r.body).toBe(200);
      return r.json() as TemplateEditSummary[];
    };
    const a = await ids(editorA.cookie);
    expect(a.map((s) => s.id).sort()).toEqual([ownA, uploadedA].sort());
    expect(a.every((s) => s.ownerId === editorA.id && s.canDelete)).toBe(true);
    expect(await ids(editorC.cookie)).toEqual([]);
    const all = (await ids(admin)).map((s) => s.id);
    expect(all).toEqual(expect.arrayContaining([ownA, uploadedA, foreignClosed, foreignPublic]));
    expect((await req('GET', '/api/templates?scope=edit', user)).statusCode).toBe(403);
  });

  it('правит свой закрытый шаблон, но не генерирует по нему отчёт', async () => {
    const d = await req('GET', `/api/templates/${ownA}`, editorA.cookie);
    expect(d.json()).toHaveProperty('queries');
    const q = await req('PUT', `/api/templates/${ownA}/queries`, editorA.cookie, [QUERY]);
    expect(q.statusCode, q.body).toBe(200);
    const p = await req('POST', `/api/templates/${ownA}/preview`, editorA.cookie, {
      params: {},
      mode: 'data',
    });
    expect(p.statusCode, p.body).toBe(200);
    const run = await req('POST', `/api/templates/${ownA}/queries/run`, editorA.cookie, {
      sql: 'select 1 as n',
      params: {},
    });
    expect(run.statusCode, run.body).toBe(200);
    const render = await req('POST', `/api/reports/${ownA}/render`, editorA.cookie, {
      params: {},
      format: 'pdf',
    });
    expect(render.statusCode).toBe(404);

    // Чужой редактор шаблона не видит.
    const c = editorC.cookie;
    expect((await req('GET', `/api/templates/${ownA}`, c)).statusCode).toBe(404);
    expect((await req('PUT', `/api/templates/${ownA}/queries`, c, [QUERY])).statusCode).toBe(404);
    expect(
      (await req('POST', `/api/templates/${ownA}/preview`, c, { params: {}, mode: 'data' }))
        .statusCode,
    ).toBe(404);
    expect(
      (await req('POST', `/api/templates/${ownA}/queries/run`, c, { sql: 'select 1', params: {} }))
        .statusCode,
    ).toBe(404);
  });

  it('варианты параметра в превью: свой закрытый шаблон — 200, чужой редактор — 404', async () => {
    const param = {
      name: 'city',
      label: 'Город',
      type: 'query',
      required: false,
      defaultValue: null,
      options: null,
      sql: "select 1 as value, 'Москва' as label",
      multiple: false,
    };
    const url = (id: string) => `/api/templates/${id}/params/city/options`;
    const p = await req('PUT', `/api/templates/${ownA}/params`, editorA.cookie, [param]);
    expect(p.statusCode, p.body).toBe(200);
    const a = await req('POST', url(ownA), editorA.cookie, { params: {} });
    expect(a.statusCode, a.body).toBe(200);
    expect(a.json()).toMatchObject({ options: [{ value: 1, label: 'Москва' }] });
    expect((await req('POST', url(ownA), editorC.cookie, { params: {} })).statusCode).toBe(404);
    // Пользователь с доступом по §19 по-прежнему получает варианты.
    const pub = await req('PUT', `/api/templates/${foreignPublic}/params`, admin, [param]);
    expect(pub.statusCode, pub.body).toBe(200);
    const u = await req('POST', url(foreignPublic), user, { params: {} });
    expect(u.statusCode, u.body).toBe(200);
  });

  it('выданный редактор правит, но не удаляет', async () => {
    await t.deps.db.insert(templateEditors).values({ templateId: ownA, userId: editorB.id });
    const d = await req('GET', `/api/templates/${ownA}`, editorB.cookie);
    expect(d.statusCode).toBe(200);
    expect(d.json()).toMatchObject({
      ownerId: editorA.id,
      canDelete: false,
      canManageEditors: false,
    });
    expect(d.json()).toHaveProperty('queries');
    const q = await req('PUT', `/api/templates/${ownA}/queries`, editorB.cookie, [QUERY]);
    expect(q.statusCode, q.body).toBe(200);
    const del = await req('DELETE', `/api/templates/${ownA}`, editorB.cookie);
    expect(del.statusCode).toBe(403);
    expect(del.json().error.message).toBe('нет права на правку шаблона');
  });

  it('видимый, но не редактируемый шаблон: карточка пользователя и 403 на правку', async () => {
    const d = await req('GET', `/api/templates/${foreignPublic}`, editorC.cookie);
    expect(d.statusCode).toBe(200);
    expect(d.json()).not.toHaveProperty('queries');
    const p = await req('PATCH', `/api/templates/${foreignPublic}`, editorC.cookie, { name: 'x' });
    expect(p.statusCode).toBe(403);
    expect(p.json().error.message).toBe('нет права на правку шаблона');
  });

  it('владелец удаляет, выданный редактор копирует себе', async () => {
    const del = await req('DELETE', `/api/templates/${uploadedA}`, editorA.cookie);
    expect(del.statusCode, del.body).toBe(204);
    const dup = await req('POST', `/api/templates/${ownA}/duplicate`, editorB.cookie);
    expect(dup.statusCode, dup.body).toBe(201);
    const [copy] = await t.deps.db.select().from(templates).where(eq(templates.id, dup.json().id));
    expect(copy!.ownerId).toBe(editorB.id);
  });

  it('блокировка правки: выданный редактор захватывает, чужой — 404', async () => {
    const holder = randomUUID();
    const b = await req('POST', `/api/templates/${ownA}/edit-lock`, editorB.cookie, {
      holder,
      acquire: true,
    });
    expect(b.statusCode, b.body).toBe(200);
    expect(b.json()).toEqual({ state: 'mine' });
    const c = await req('POST', `/api/templates/${ownA}/edit-lock`, editorC.cookie, {
      holder: randomUUID(),
      acquire: true,
    });
    expect(c.statusCode).toBe(404);
    await req('DELETE', `/api/templates/${ownA}/edit-lock?holder=${holder}`, editorB.cookie);
  });

  it('выгрузка в архив — только свои шаблоны', async () => {
    const exp = (ids: string[]) => req('POST', '/api/templates/export', editorA.cookie, { ids });
    expect((await exp([ownA, foreignClosed])).statusCode).toBe(404);
    const vis = await exp([ownA, foreignPublic]);
    expect(vis.statusCode).toBe(403);
    expect(vis.json().error.message).toBe('нет права на правку шаблона');
    const ok = await exp([ownA]);
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.headers['content-type']).toBe('application/zip');
  });

  it('конфиг OnlyOffice: редактор шаблона — 200, чужой — 404, пользователь — 403', async () => {
    const url = `/api/templates/${ownA}/editor-config?holder=${randomUUID()}`;
    expect((await req('GET', url, editorA.cookie)).statusCode).toBe(200);
    expect((await req('GET', url, editorC.cookie)).statusCode).toBe(404);
    expect((await req('GET', url, user)).statusCode).toBe(403);
  });

  it('понижение до пользователя: сессия сброшена, после входа — 403', async () => {
    const r = await req('PATCH', `/api/users/${editorA.id}`, admin, { role: 'user' });
    expect(r.statusCode, r.body).toBe(200);
    expect(
      (await req('PUT', `/api/templates/${ownA}/queries`, editorA.cookie, [QUERY])).statusCode,
    ).toBe(401);
    const login = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { login: editorA.login, password: 'password123' },
    });
    expect(login.statusCode).toBe(200);
    const cookie = String(login.headers['set-cookie']).split(';')[0]!;
    expect((await req('PUT', `/api/templates/${ownA}/queries`, cookie, [QUERY])).statusCode).toBe(
      403,
    );
  });
});
