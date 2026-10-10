import { createHash, randomUUID } from 'node:crypto';
import { TransferManifest } from '@carbone-reports/shared/template-transfer';
import { eq } from 'drizzle-orm';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { categories, groups, templateGroups, templates } from '../src/db/schema';
import {
  createSourceDatabase,
  createTemplate,
  createTestApp,
  loginAs,
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

const exportIds = (cookie: string, ids: string[]) =>
  t.app.inject({
    method: 'POST',
    url: '/api/templates/export',
    headers: { cookie },
    payload: { ids },
  });

describe('POST /api/templates/export', () => {
  it('один шаблон: имя <имя>.crt.zip, все поля §33.1, sha256 файла из хранилища', async () => {
    const id = await createTemplate(t, admin, dsId, {
      queries: [
        { key: 'b', sql: 'select 2', mode: 'single' },
        { key: 'a', sql: 'select 1', mode: 'list' },
      ],
      params: [
        {
          name: 'from',
          label: 'С',
          type: 'date',
          required: true,
          defaultValue: null,
          options: null,
          sql: null,
          multiple: false,
        },
      ],
    });
    const [cat] = await t.deps.db
      .insert(categories)
      .values({ name: `Кат ${randomUUID().slice(0, 4)}` })
      .returning();
    const [grp] = await t.deps.db
      .insert(groups)
      .values({ name: `Гр ${randomUUID().slice(0, 4)}` })
      .returning();
    await t.deps.db
      .update(templates)
      .set({ categoryId: cat!.id, public: true, defaultOutput: 'odt', name: 'Счёт: №1/2' })
      .where(eq(templates.id, id));
    await t.deps.db.insert(templateGroups).values({ templateId: id, groupId: grp!.id });

    const r = await exportIds(admin, [id, id]);
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('application/zip');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(String(r.headers['content-disposition'])).toContain(
      `filename*=UTF-8''${encodeURIComponent('Счёт_№1_2.crt.zip')}`,
    );
    const zip = await JSZip.loadAsync(r.rawPayload);
    expect(Object.keys(zip.files).sort()).toEqual(['manifest.json', 'templates/1/template.docx']);
    const text = await zip.file('manifest.json')!.async('string');
    const m = TransferManifest.parse(JSON.parse(text));
    expect(m.templates).toHaveLength(1);
    const x = m.templates[0]!;
    expect(x).toMatchObject({
      name: 'Счёт: №1/2',
      fileExt: 'docx',
      defaultOutput: 'odt',
      public: true,
      category: cat!.name,
      groups: [grp!.name],
      datasource: { name: 'src', sslMode: 'disable' },
      queries: [
        { key: 'b', mode: 'single', sortOrder: 0 },
        { key: 'a', mode: 'list', sortOrder: 1 },
      ],
      params: [{ name: 'from', type: 'date', sortOrder: 0 }],
    });
    const file = Buffer.from(await zip.file(x.file)!.async('uint8array'));
    expect(x.sha256).toBe(createHash('sha256').update(file).digest('hex'));
    expect(await t.deps.storage.read(`templates/${id}/v1.docx`)).toEqual(file);
    // Ни паролей и CA источника, ни идентификаторов, ни дат.
    expect(text).not.toMatch(/password|sslCa|updatedAt|updatedBy/i);
    expect(text).not.toContain(id);
    expect(text).not.toContain(dsId);
  });

  it('несколько шаблонов: templates-YYYY-MM-DD.crt.zip, порядок как в запросе', async () => {
    const a = await createTemplate(t, admin, dsId);
    const b = await createTemplate(t, admin, dsId);
    const r = await exportIds(admin, [b, a]);
    expect(r.statusCode).toBe(200);
    expect(String(r.headers['content-disposition'])).toMatch(
      /filename="templates-\d{4}-\d{2}-\d{2}\.crt\.zip"/,
    );
    const zip = await JSZip.loadAsync(r.rawPayload);
    const m = TransferManifest.parse(JSON.parse(await zip.file('manifest.json')!.async('string')));
    const names = (
      await Promise.all(
        [b, a].map((id) => t.deps.db.select().from(templates).where(eq(templates.id, id))),
      )
    ).map((rows) => rows[0]!.name);
    expect(m.templates.map((x) => x.name)).toEqual(names);
  });

  it('404 на несуществующий id, 403 пользователю, 400 на пустой список', async () => {
    const id = await createTemplate(t, admin, dsId);
    const bad = await exportIds(admin, [id, randomUUID()]);
    expect(bad.statusCode).toBe(404);
    expect(bad.json().error.code).toBe('NOT_FOUND');
    expect((await exportIds(user, [id])).statusCode).toBe(403);
    expect((await exportIds(admin, [])).statusCode).toBe(400);
  });
});
