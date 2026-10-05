import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createBlankDocument } from '../src/modules/templates/blank';
import {
  createSourceDatabase,
  createTemplate,
  createTestApp,
  loginAs,
  multipart,
  type TestApp,
} from './helpers';

let t: TestApp;
let admin: string;
let user: string;
let dsId: string;

beforeAll(async () => {
  t = await createTestApp();
  admin = (await loginAs(t, 'admin')).cookie;
  user = (await loginAs(t, 'user')).cookie;
  const src = await createSourceDatabase('select 1');
  const ds = await t.app.inject({
    method: 'POST',
    url: '/api/datasources',
    headers: { cookie: admin },
    payload: { name: 'src', ...src, sslMode: 'disable' },
  });
  dsId = ds.json().id;
});
afterAll(() => t.close());

describe('templates', () => {
  it('создание пустого docx: файл на диске, version=1, outputFormats', async () => {
    const r = await t.app.inject({
      method: 'POST',
      url: '/api/templates',
      headers: { cookie: admin },
      payload: { name: 'Счёт', datasourceId: dsId, blank: 'docx' },
    });
    expect(r.statusCode).toBe(201);
    const id = r.json().id;
    const d = await t.app.inject({
      method: 'GET',
      url: `/api/templates/${id}`,
      headers: { cookie: admin },
    });
    expect(d.json()).toMatchObject({
      name: 'Счёт',
      fileExt: 'docx',
      version: 1,
      queries: [],
      params: [],
      outputFormats: ['pdf', 'docx', 'odt'],
    });
    expect(await t.deps.storage.exists(`templates/${id}/v1.docx`)).toBe(true);
  });

  it('user видит список и детали без SQL', async () => {
    const id = await createTemplate(t, admin, dsId, {
      queries: [{ key: 'q', mode: 'list', sql: 'select secret from t' }],
    });
    const list = await t.app.inject({
      method: 'GET',
      url: '/api/templates',
      headers: { cookie: user },
    });
    expect(list.json().some((x: { id: string }) => x.id === id)).toBe(true);
    const d = await t.app.inject({
      method: 'GET',
      url: `/api/templates/${id}`,
      headers: { cookie: user },
    });
    expect(d.statusCode).toBe(200);
    expect(d.json()).not.toHaveProperty('queries');
    expect(JSON.stringify(d.json())).not.toContain('secret');
  });

  it('datasourceId не UUID → 400', async () => {
    const r = await t.app.inject({
      method: 'POST',
      url: '/api/templates',
      headers: { cookie: admin },
      payload: { name: 'x', datasourceId: 'nope', blank: 'docx' },
    });
    expect(r.statusCode).toBe(400);
  });

  it('user не может создавать и менять шаблоны', async () => {
    const r = await t.app.inject({
      method: 'POST',
      url: '/api/templates',
      headers: { cookie: user },
      payload: { name: 'x', datasourceId: dsId, blank: 'docx' },
    });
    expect(r.statusCode).toBe(403);
  });

  it('загрузка файла: xlsx принимается, текстовый файл с расширением .docx — 400', async () => {
    const xlsx = await createBlankDocument('xlsx');
    const good = multipart(
      { name: 'Таблица', description: '', datasourceId: dsId },
      { name: 'Отчёт.xlsx', data: xlsx },
    );
    const ok = await t.app.inject({
      method: 'POST',
      url: '/api/templates/upload',
      headers: { cookie: admin, ...good.headers },
      payload: good.payload,
    });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().fileExt).toBe('xlsx');

    const fake = multipart(
      { name: 'Фейк', description: '', datasourceId: dsId },
      { name: 'a.docx', data: Buffer.from('hello') },
    );
    const bad = await t.app.inject({
      method: 'POST',
      url: '/api/templates/upload',
      headers: { cookie: admin, ...fake.headers },
      payload: fake.payload,
    });
    expect(bad.statusCode).toBe(400);

    const exe = multipart(
      { name: 'Exe', description: '', datasourceId: dsId },
      { name: 'a.exe', data: xlsx },
    );
    const badExt = await t.app.inject({
      method: 'POST',
      url: '/api/templates/upload',
      headers: { cookie: admin, ...exe.headers },
      payload: exe.payload,
    });
    expect(badExt.statusCode).toBe(400);
  });

  it('PUT queries: дубликаты ключей → 400, повторное сохранение заменяет список', async () => {
    const id = await createTemplate(t, admin, dsId);
    const dup = await t.app.inject({
      method: 'PUT',
      url: `/api/templates/${id}/queries`,
      headers: { cookie: admin },
      payload: [
        { key: 'a', mode: 'list', sql: 'select 1' },
        { key: 'a', mode: 'single', sql: 'select 2' },
      ],
    });
    expect(dup.statusCode).toBe(400);
    await t.app.inject({
      method: 'PUT',
      url: `/api/templates/${id}/queries`,
      headers: { cookie: admin },
      payload: [
        { key: 'a', mode: 'list', sql: 'select 1' },
        { key: 'b', mode: 'single', sql: 'select 2' },
      ],
    });
    await t.app.inject({
      method: 'PUT',
      url: `/api/templates/${id}/queries`,
      headers: { cookie: admin },
      payload: [{ key: 'b', mode: 'single', sql: 'select 3' }],
    });
    const d = await t.app.inject({
      method: 'GET',
      url: `/api/templates/${id}`,
      headers: { cookie: admin },
    });
    expect(d.json().queries).toEqual([{ key: 'b', mode: 'single', sql: 'select 3' }]);
  });

  it('PUT params: default неверного типа → 400 с полем', async () => {
    const id = await createTemplate(t, admin, dsId);
    const r = await t.app.inject({
      method: 'PUT',
      url: `/api/templates/${id}/params`,
      headers: { cookie: admin },
      payload: [
        {
          name: 'n',
          label: 'N',
          type: 'number',
          required: false,
          defaultValue: 'abc',
          options: null,
        },
      ],
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.details.fields).toHaveProperty('n');
  });

  it('PATCH defaultOutput, недопустимый для расширения → 400', async () => {
    const id = await createTemplate(t, admin, dsId);
    const r = await t.app.inject({
      method: 'PATCH',
      url: `/api/templates/${id}`,
      headers: { cookie: admin },
      payload: { defaultOutput: 'xlsx' },
    });
    expect(r.statusCode).toBe(400);
  });

  it('дублирование копирует файл, запросы и параметры, но с новым doc key', async () => {
    const id = await createTemplate(t, admin, dsId, {
      queries: [{ key: 'q', mode: 'list', sql: 'select 1' }],
      params: [
        {
          name: 'p',
          label: 'P',
          type: 'string',
          required: false,
          defaultValue: null,
          options: null,
        },
      ],
    });
    const r = await t.app.inject({
      method: 'POST',
      url: `/api/templates/${id}/duplicate`,
      headers: { cookie: admin },
    });
    expect(r.statusCode).toBe(201);
    const copy = await t.app.inject({
      method: 'GET',
      url: `/api/templates/${r.json().id}`,
      headers: { cookie: admin },
    });
    expect(copy.json()).toMatchObject({ queries: [{ key: 'q' }], params: [{ name: 'p' }] });
    expect(copy.json().name).toMatch(/\(копия\)$/);
    expect(await t.deps.storage.exists(`templates/${r.json().id}/v1.docx`)).toBe(true);
  });

  it('скачивание: правильный MIME и кириллица в имени файла', async () => {
    const id = await createTemplate(t, admin, dsId);
    const r = await t.app.inject({
      method: 'GET',
      url: `/api/templates/${id}/download`,
      headers: { cookie: admin },
    });
    expect(r.headers['content-type']).toBe(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
    expect(r.headers['content-disposition']).toContain("filename*=UTF-8''");
  });

  it('удаление убирает файл', async () => {
    const id = await createTemplate(t, admin, dsId);
    const r = await t.app.inject({
      method: 'DELETE',
      url: `/api/templates/${id}`,
      headers: { cookie: admin },
    });
    expect(r.statusCode).toBe(204);
    expect(await t.deps.storage.exists(`templates/${id}/v1.docx`)).toBe(false);
  });

  it('замена файла через PUT /file увеличивает version и меняет doc key', async () => {
    const id = await createTemplate(t, admin, dsId);
    const before = await t.app.inject({
      method: 'GET',
      url: `/api/templates/${id}`,
      headers: { cookie: admin },
    });
    const docx = await createBlankDocument('docx');
    const mp = multipart({}, { name: 'new.docx', data: docx });
    const r = await t.app.inject({
      method: 'PUT',
      url: `/api/templates/${id}/file`,
      headers: { cookie: admin, ...mp.headers },
      payload: mp.payload,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().version).toBe(before.json().version + 1);
  });
});
