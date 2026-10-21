import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { templateEditors } from '../src/db/schema';
import { makePdf } from '../src/modules/pdf/test-pdf';
import { createBlankDocument } from '../src/modules/templates/blank';
import {
  createSourceDatabase,
  createTemplate,
  createTestApp,
  loginAs,
  multipart,
  type TestApp,
} from './helpers';

/**
 * Матрица §43.2/§43.6 по маршрутам с :id шаблона: роль × отношение к шаблону × ожидаемый код.
 * Невидимый шаблон — 404, видимый по §19 без права правки — 403, роль без права — 403.
 * Каждая ячейка — на свежем шаблоне: разрешённые запросы меняют его (удаление, замена файла).
 */
let t: TestApp;
let adminCookie: string;
let editor: { cookie: string; id: string };
/** Другой редактор: владелец «выданного» шаблона. */
let otherEditor: { cookie: string; id: string };
let managerCookie: string;
let userCookie: string;
let dsId: string;
let pdf: Buffer;
let docx: Buffer;

beforeAll(async () => {
  t = await createTestApp({ onlyoffice: { forceSave: async () => {} } });
  adminCookie = (await loginAs(t, 'admin')).cookie;
  const e = await loginAs(t, 'editor');
  editor = { cookie: e.cookie, id: e.user.id };
  const o = await loginAs(t, 'editor');
  otherEditor = { cookie: o.cookie, id: o.user.id };
  managerCookie = (await loginAs(t, 'access_manager')).cookie;
  userCookie = (await loginAs(t, 'user')).cookie;
  const src = await createSourceDatabase('select 1');
  dsId = (
    await t.app.inject({
      method: 'POST',
      url: '/api/datasources',
      headers: { cookie: adminCookie },
      payload: { name: 'src', ...src, sslMode: 'disable' },
    })
  ).json().id;
  pdf = Buffer.from(await makePdf([{ label: 'a' }]));
  docx = await createBlankDocument('docx');
});
afterAll(() => t?.close());

type Relation = 'own' | 'granted' | 'foreignInvisible' | 'foreignVisible';

/** Свежий шаблон в нужном отношении к редактору `editor`. */
async function templateFor(rel: Relation): Promise<string> {
  switch (rel) {
    case 'own':
      return createTemplate(t, editor.cookie, dsId);
    case 'granted': {
      const id = await createTemplate(t, otherEditor.cookie, dsId);
      await t.deps.db.insert(templateEditors).values({ templateId: id, userId: editor.id });
      return id;
    }
    case 'foreignInvisible':
      return createTemplate(t, adminCookie, dsId);
    case 'foreignVisible':
      return createTemplate(t, adminCookie, dsId, { public: true });
  }
}

type Res = Awaited<ReturnType<TestApp['app']['inject']>>;
const json = (
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
const form = (
  method: 'POST' | 'PUT',
  url: string,
  cookie: string,
  fields: Record<string, string>,
  file: { name: string; data: Buffer },
) => {
  const m = multipart(fields, file);
  return t.app.inject({ method, url, headers: { cookie, ...m.headers }, payload: m.payload });
};

/** Приложение PDF от админа: id для маршрутов attachments/:aid. */
async function attachment(id: string): Promise<string> {
  const r = await form(
    'POST',
    `/api/templates/${id}/attachments`,
    adminCookie,
    { placement: 'end' },
    {
      name: 'a.pdf',
      data: pdf,
    },
  );
  expect(r.statusCode, r.body).toBe(201);
  return r.json().attachments.at(-1).id;
}

/**
 * Права маршрута: edit — canEditTemplate; owner — admin или владелец; admin — только admin;
 * access — admin и access_manager любой шаблон, editor — при canEditTemplate.
 */
type Kind = 'edit' | 'owner' | 'admin' | 'access';
interface Route {
  name: string;
  kind: Kind;
  /** Код успешного ответа. */
  ok: number;
  send: (id: string, cookie: string) => Promise<Res>;
}

const holder = () => randomUUID();

const ROUTES: Route[] = [
  {
    name: 'GET tag-warnings',
    kind: 'edit',
    ok: 200,
    send: (id, c) => json('GET', `/api/templates/${id}/tag-warnings`, c),
  },
  {
    name: 'PUT file',
    kind: 'edit',
    ok: 200,
    send: (id, c) =>
      form('PUT', `/api/templates/${id}/file`, c, {}, { name: 'n.docx', data: docx }),
  },
  {
    name: 'PATCH шаблона',
    kind: 'edit',
    ok: 200,
    send: (id, c) => json('PATCH', `/api/templates/${id}`, c, { description: 'матрица' }),
  },
  {
    name: 'DELETE шаблона',
    kind: 'owner',
    ok: 204,
    send: (id, c) => json('DELETE', `/api/templates/${id}`, c),
  },
  {
    name: 'POST duplicate',
    kind: 'edit',
    ok: 201,
    send: (id, c) => json('POST', `/api/templates/${id}/duplicate`, c),
  },
  {
    name: 'GET download',
    kind: 'edit',
    ok: 200,
    send: (id, c) => json('GET', `/api/templates/${id}/download`, c),
  },
  {
    name: 'POST export',
    kind: 'edit',
    ok: 200,
    send: (id, c) => json('POST', '/api/templates/export', c, { ids: [id] }),
  },
  {
    name: 'PUT queries',
    kind: 'edit',
    ok: 200,
    send: (id, c) =>
      json('PUT', `/api/templates/${id}/queries`, c, [
        { key: 'rows', mode: 'list', sql: 'select 1' },
      ]),
  },
  {
    name: 'PUT params',
    kind: 'edit',
    ok: 200,
    send: (id, c) => json('PUT', `/api/templates/${id}/params`, c, []),
  },
  {
    name: 'PUT charts',
    kind: 'edit',
    ok: 200,
    send: (id, c) => json('PUT', `/api/templates/${id}/charts`, c, []),
  },
  {
    name: 'PUT pdf-options',
    kind: 'edit',
    ok: 200,
    send: (id, c) => json('PUT', `/api/templates/${id}/pdf-options`, c, { pdfa: false }),
  },
  {
    name: 'POST attachments',
    kind: 'edit',
    ok: 201,
    send: (id, c) =>
      form(
        'POST',
        `/api/templates/${id}/attachments`,
        c,
        { placement: 'end' },
        { name: 'a.pdf', data: pdf },
      ),
  },
  {
    name: 'PATCH attachments/:aid',
    kind: 'edit',
    ok: 200,
    send: async (id, c) =>
      json('PATCH', `/api/templates/${id}/attachments/${await attachment(id)}`, c, {
        placement: 'start',
      }),
  },
  {
    name: 'DELETE attachments/:aid',
    kind: 'edit',
    ok: 200,
    send: async (id, c) =>
      json('DELETE', `/api/templates/${id}/attachments/${await attachment(id)}`, c),
  },
  {
    name: 'POST edit-lock',
    kind: 'edit',
    ok: 200,
    send: (id, c) =>
      json('POST', `/api/templates/${id}/edit-lock`, c, { holder: holder(), acquire: true }),
  },
  {
    name: 'POST edit-lock/takeover (у админа)',
    kind: 'edit',
    ok: 200,
    send: async (id, c) => {
      const r = await json('POST', `/api/templates/${id}/edit-lock`, adminCookie, {
        holder: holder(),
        acquire: true,
      });
      expect(r.json()).toEqual({ state: 'mine' });
      return json('POST', `/api/templates/${id}/edit-lock/takeover`, c, { holder: holder() });
    },
  },
  {
    name: 'DELETE edit-lock',
    kind: 'edit',
    ok: 204,
    send: (id, c) => json('DELETE', `/api/templates/${id}/edit-lock?holder=${holder()}`, c),
  },
  {
    name: 'GET editor-config',
    kind: 'edit',
    ok: 200,
    send: (id, c) => json('GET', `/api/templates/${id}/editor-config?holder=${holder()}`, c),
  },
  {
    name: 'POST save (OnlyOffice)',
    kind: 'edit',
    ok: 204,
    send: async (id, c) => {
      const h = holder();
      // Блокировку берёт тот же пользователь; у кого права нет — получит отказ уже здесь.
      await json('POST', `/api/templates/${id}/edit-lock`, c, { holder: h, acquire: true });
      return json('POST', `/api/templates/${id}/save`, c, { holder: h });
    },
  },
  {
    name: 'POST queries/run',
    kind: 'edit',
    ok: 200,
    send: (id, c) =>
      json('POST', `/api/templates/${id}/queries/run`, c, { sql: 'select 1 as n', params: {} }),
  },
  {
    name: 'POST preview',
    kind: 'edit',
    ok: 200,
    send: (id, c) => json('POST', `/api/templates/${id}/preview`, c, { params: {}, mode: 'data' }),
  },
  {
    name: 'GET editors',
    kind: 'owner',
    ok: 200,
    send: (id, c) => json('GET', `/api/templates/${id}/editors`, c),
  },
  {
    name: 'PUT editors',
    kind: 'owner',
    ok: 200,
    send: (id, c) => json('PUT', `/api/templates/${id}/editors`, c, { userIds: [] }),
  },
  {
    name: 'PUT owner',
    kind: 'admin',
    ok: 200,
    send: (id, c) => json('PUT', `/api/templates/${id}/owner`, c, { userId: otherEditor.id }),
  },
  {
    name: 'GET access',
    kind: 'access',
    ok: 200,
    send: (id, c) => json('GET', `/api/templates/${id}/access`, c),
  },
  {
    name: 'PUT access',
    kind: 'access',
    ok: 200,
    send: (id, c) =>
      json('PUT', `/api/templates/${id}/access`, c, {
        public: false,
        categoryId: null,
        groupIds: [],
      }),
  },
];

type Actor = 'admin' | 'editor' | 'access_manager' | 'user';
interface Cell {
  actor: Actor;
  rel: Relation;
  /** Ожидание по виду маршрута: 'ok' — успешный код маршрута. */
  expect: Record<Kind, 'ok' | 403 | 404>;
}

const OK_ALL = { edit: 'ok', owner: 'ok', admin: 'ok', access: 'ok' } as const;
const DENY_ALL = { edit: 403, owner: 403, admin: 403, access: 403 } as const;
const MANAGER = { edit: 403, owner: 403, admin: 403, access: 'ok' } as const;

const CELLS: Cell[] = [
  { actor: 'admin', rel: 'foreignInvisible', expect: OK_ALL },
  { actor: 'admin', rel: 'own', expect: OK_ALL },
  { actor: 'editor', rel: 'own', expect: { edit: 'ok', owner: 'ok', admin: 403, access: 'ok' } },
  { actor: 'editor', rel: 'granted', expect: { edit: 'ok', owner: 403, admin: 403, access: 'ok' } },
  { actor: 'editor', rel: 'foreignVisible', expect: DENY_ALL },
  // requireAdmin проверяет роль раньше шаблона: 403, а не 404.
  {
    actor: 'editor',
    rel: 'foreignInvisible',
    expect: { edit: 404, owner: 404, admin: 403, access: 404 },
  },
  { actor: 'access_manager', rel: 'foreignVisible', expect: MANAGER },
  { actor: 'access_manager', rel: 'foreignInvisible', expect: MANAGER },
  { actor: 'user', rel: 'foreignVisible', expect: DENY_ALL },
  { actor: 'user', rel: 'foreignInvisible', expect: DENY_ALL },
];

const cookieOf = (a: Actor) =>
  ({ admin: adminCookie, editor: editor.cookie, access_manager: managerCookie, user: userCookie })[
    a
  ];

describe.each(ROUTES)('$name', (route) => {
  it.each(CELLS)('$actor × $rel', async (cell) => {
    const id = await templateFor(cell.rel);
    const r = await route.send(id, cookieOf(cell.actor));
    const want = cell.expect[route.kind];
    expect(r.statusCode, r.body).toBe(want === 'ok' ? route.ok : want);
    if (want === 404) expect(r.json().error.message).toBe('шаблон не найден');
    if (want === 403 && cell.actor === 'editor' && route.kind !== 'admin')
      expect(r.json().error.message).toBe('нет права на правку шаблона');
  });
});
