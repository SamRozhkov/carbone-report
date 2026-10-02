import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reportRuns, users } from '../src/db/schema';
import { AppError } from '../src/lib/errors';
import type { CarboneRenderer } from '../src/deps';
import {
  createSourceDatabase,
  createTemplate,
  createTestApp,
  loginAs,
  type TestApp,
} from './helpers';

let t: TestApp;
let admin: { cookie: string; user: { id: string } };
let dsId: string;
const carbone: CarboneRenderer = {
  async render() {
    throw new AppError('CARBONE_ERROR', 502, 'ошибка генерации: boom');
  },
};

beforeAll(async () => {
  t = await createTestApp({ carbone });
  admin = await loginAs(t, 'admin');
  const src = await createSourceDatabase('select 1');
  dsId = (
    await t.app.inject({
      method: 'POST',
      url: '/api/datasources',
      headers: { cookie: admin.cookie },
      payload: { name: 's', ...src, ssl: false },
    })
  ).json().id;
});
afterAll(() => t.close());

const CYRILLIC = /[а-яё]/i;

describe('русские сообщения об ошибках', () => {
  it('загрузка больше 20 МБ → 413 с русским сообщением', async () => {
    const boundary = '----big';
    const payload = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.docx"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ),
      Buffer.alloc(20 * 1024 * 1024 + 1024, 1),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const r = await t.app.inject({
      method: 'POST',
      url: '/api/templates/upload',
      headers: {
        cookie: admin.cookie,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload,
    });
    expect(r.statusCode).toBe(413);
    expect(r.json().error.message).toBe('файл больше 20 МБ');
  });

  it('невалидный JSON → 400 с русским сообщением', async () => {
    const r = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'content-type': 'application/json' },
      payload: '{oops',
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toBe('некорректный JSON в теле запроса');
  });

  it('JSON больше 1 МБ → 413 с русским сообщением', async () => {
    const r = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { login: 'a', password: 'b', pad: 'x'.repeat(1024 * 1024 + 10) },
    });
    expect(r.statusCode).toBe(413);
    expect(r.json().error.message).toBe('тело запроса слишком большое');
  });

  it('ошибка валидации zod содержит кириллицу', async () => {
    const r = await t.app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: admin.cookie },
      payload: { login: 'ab', password: 'password1', role: 'user' },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error.details[0].message).toMatch(CYRILLIC);
  });
});

describe('удаление пользователя', () => {
  it('удаляет файлы отчётов пользователя', async () => {
    const victim = await loginAs(t, 'user');
    const id = crypto.randomUUID();
    const filePath = `reports/${id}.pdf`;
    await t.deps.storage.write(filePath, Buffer.from('pdf'));
    await t.deps.db.insert(reportRuns).values({
      id,
      templateId: null,
      templateName: 'x',
      templateVersion: 1,
      userId: victim.user.id,
      params: {},
      outputFormat: 'pdf',
      status: 'ok',
      filePath,
      durationMs: 1,
    });
    const r = await t.app.inject({
      method: 'DELETE',
      url: `/api/users/${victim.user.id}`,
      headers: { cookie: admin.cookie },
    });
    expect(r.statusCode).toBe(204);
    expect(await t.deps.storage.exists(filePath)).toBe(false);
    expect(await t.deps.db.select().from(users).where(eq(users.id, victim.user.id))).toHaveLength(
      0,
    );
  });
});

describe('запись об ошибке генерации', () => {
  it('SQL-ошибка: сохраняются разрешённые параметры', async () => {
    const id = await createTemplate(t, admin.cookie, dsId, {
      queries: [{ key: 'q', mode: 'list', sql: 'select nope' }],
      params: [
        {
          name: 'a',
          label: 'A',
          type: 'string',
          required: false,
          defaultValue: 'dflt',
          options: null,
        },
      ],
    });
    const r = await t.app.inject({
      method: 'POST',
      url: `/api/reports/${id}/render`,
      headers: { cookie: admin.cookie },
      payload: { params: { junk: 'x' }, format: 'pdf' },
    });
    expect(r.statusCode).toBe(400);
    const [run] = await t.deps.db.select().from(reportRuns).where(eq(reportRuns.templateId, id));
    expect(run!.params).toEqual({ a: 'dflt' });
  });
});
