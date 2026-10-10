import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ImportDecision,
  ImportPreview,
  ImportResult,
} from '@carbone-reports/shared/template-transfer';
import { asc, eq, sql } from 'drizzle-orm';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  categories,
  groups,
  reportRuns,
  templateGroups,
  templateParams,
  templateQueries,
  templates,
} from '../src/db/schema';
import {
  createSourceDatabase,
  createTemplate,
  createTestApp,
  listKeys,
  loginAs,
  multipart,
  type SourceConn,
  type TestApp,
} from './helpers';

/** Две «среды» — два приложения со своими БД и хранилищами. */
let a: TestApp;
let b: TestApp;
let adminA: string;
let adminB: string;
let adminBId: string;
let dsA: string;
let dsB: string;
let src: SourceConn;

async function createDatasource(t: TestApp, cookie: string, name: string): Promise<string> {
  const r = await t.app.inject({
    method: 'POST',
    url: '/api/datasources',
    headers: { cookie },
    payload: { name, ...src, sslMode: 'disable' },
  });
  if (r.statusCode !== 201) throw new Error(r.body);
  return r.json().id as string;
}

beforeAll(async () => {
  [a, b] = await Promise.all([createTestApp(), createTestApp()]);
  adminA = (await loginAs(a, 'admin')).cookie;
  const lb = await loginAs(b, 'admin');
  adminB = lb.cookie;
  adminBId = lb.user.id;
  src = await createSourceDatabase('select 1');
  dsA = await createDatasource(a, adminA, 'Учёт');
  dsB = await createDatasource(b, adminB, 'Учёт');
});
afterAll(async () => {
  await Promise.all([a?.close(), b?.close()]);
});

async function exportZip(t: TestApp, cookie: string, ids: string[]): Promise<Buffer> {
  const r = await t.app.inject({
    method: 'POST',
    url: '/api/templates/export',
    headers: { cookie },
    payload: { ids },
  });
  expect(r.statusCode).toBe(200);
  return r.rawPayload;
}

const preview = (t: TestApp, cookie: string, zip: Buffer) => {
  const body = multipart({}, { name: 'x.crt.zip', data: zip });
  return t.app.inject({
    method: 'POST',
    url: '/api/templates/import/preview',
    headers: { cookie, ...body.headers },
    payload: body.payload,
  });
};

const apply = (t: TestApp, cookie: string, zip: Buffer, decisions: ImportDecision[]) => {
  const body = multipart(
    { decisions: JSON.stringify(decisions) },
    { name: 'x.crt.zip', data: zip },
  );
  return t.app.inject({
    method: 'POST',
    url: '/api/templates/import',
    headers: { cookie, ...body.headers },
    payload: body.payload,
  });
};

async function manifestOf(zip: Buffer): Promise<Record<string, unknown>> {
  const z = await JSZip.loadAsync(zip);
  const m = JSON.parse(await z.file('manifest.json')!.async('string'));
  delete m.exportedAt;
  delete m.appVersion;
  return m;
}

/** id шаблонов, у которых есть файлы в хранилище. */
async function storedTemplateIds(t: TestApp): Promise<Set<string>> {
  if (t.deps.config.s3) {
    const keys = await listKeys(t.deps.config.s3);
    return new Set(keys.filter((k) => k.startsWith('templates/')).map((k) => k.split('/')[1]!));
  }
  const dir = join(t.deps.config.storageDir, 'templates');
  return new Set(await readdir(dir).catch(() => []));
}

async function dbTemplateIds(t: TestApp): Promise<Set<string>> {
  return new Set((await t.deps.db.select({ id: templates.id }).from(templates)).map((r) => r.id));
}

/** Шаблон в среде A с запросами, параметрами, категорией, группами, публичностью и форматом. */
async function richTemplate(name: string): Promise<string> {
  const id = await createTemplate(a, adminA, dsA, {
    queries: [
      { key: 'rows', sql: 'select 1 as x', mode: 'list' },
      { key: 'head', sql: 'select 2 as y', mode: 'single' },
    ],
    params: [
      {
        name: 'region',
        label: 'Регион',
        type: 'select',
        required: true,
        defaultValue: 'n',
        options: [
          { value: 'n', label: 'Север' },
          { value: 's', label: 'Юг' },
        ],
        sql: null,
        multiple: false,
      },
      {
        name: 'city',
        label: 'Город',
        type: 'query',
        required: false,
        defaultValue: null,
        options: null,
        sql: 'select :region as value, :region as label',
        multiple: true,
      },
    ],
  });
  const [cat] = await a.deps.db
    .insert(categories)
    .values({ name: `Финансы ${randomUUID().slice(0, 4)}` })
    .returning();
  const gs = await a.deps.db
    .insert(groups)
    .values([{ name: 'Бухгалтерия' }, { name: 'Только в A' }])
    .onConflictDoNothing()
    .returning();
  const all = gs.length ? gs : await a.deps.db.select().from(groups);
  await a.deps.db
    .update(templates)
    .set({ name, categoryId: cat!.id, public: true, defaultOutput: 'odt', description: 'Описание' })
    .where(eq(templates.id, id));
  await a.deps.db
    .insert(templateGroups)
    .values(all.map((g) => ({ templateId: id, groupId: g.id })));
  return id;
}

describe('перенос шаблонов между средами', () => {
  let zip: Buffer;
  let name: string;
  let importedId: string;

  beforeAll(async () => {
    name = `Счёт ${randomUUID().slice(0, 6)}`;
    zip = await exportZip(a, adminA, [await richTemplate(name)]);
    await b.deps.db.insert(groups).values({ name: 'бухгалтерия' }); // без учёта регистра
  });

  it('предпросмотр: источник по имени, нет группы, будет создана категория; ничего не меняет', async () => {
    const before = await dbTemplateIds(b);
    const r = await preview(b, adminB, zip);
    expect(r.statusCode).toBe(200);
    const p = r.json() as ImportPreview;
    expect(p.templates).toHaveLength(1);
    expect(p.templates[0]).toMatchObject({
      index: 0,
      name,
      existing: [],
      datasourceMatch: dsB,
      categoryExists: false,
      missingGroups: ['Только в A'],
      errors: [],
      datasource: { name: 'Учёт', database: src.database },
    });
    expect(JSON.stringify(p)).not.toMatch(/password/i);
    expect(await dbTemplateIds(b)).toEqual(before);
  });

  it('без datasourceId — 400, ничего не создано', async () => {
    const r = await apply(b, adminB, zip, [{ index: 0, action: 'create' }]);
    expect(r.statusCode).toBe(400);
    expect(r.json().error.message).toMatch(/выберите источник/);
    expect((await dbTemplateIds(b)).size).toBe(0);
  });

  it('create и круговой перенос: манифест повторной выгрузки совпадает', async () => {
    const r = await apply(b, adminB, zip, [{ index: 0, action: 'create', datasourceId: dsB }]);
    expect(r.statusCode).toBe(200);
    const res = r.json() as ImportResult;
    expect(res.templates).toEqual([{ index: 0, action: 'create', name, id: expect.any(String) }]);
    importedId = res.templates[0]!.id!;
    const [row] = await b.deps.db.select().from(templates).where(eq(templates.id, importedId));
    expect(row).toMatchObject({ datasourceId: dsB, version: 1, updatedBy: adminBId });
    const again = await exportZip(b, adminB, [importedId]);
    const m2 = await manifestOf(again);
    // Отличие только в группе, которой нет в B (пропущена) — сравниваем с её учётом.
    const m1 = await manifestOf(zip);
    const t1 = (m1.templates as { groups: string[] }[])[0]!;
    t1.groups = ['бухгалтерия'];
    expect(m2).toEqual(m1);
  });

  it('create при существующем имени — 400; copy — «(2)», затем «(3)»; skip', async () => {
    const dup = await apply(b, adminB, zip, [{ index: 0, action: 'create', datasourceId: dsB }]);
    expect(dup.statusCode).toBe(400);
    const p = (await preview(b, adminB, zip)).json() as ImportPreview;
    expect(p.templates[0]!.existing).toEqual([
      { id: importedId, name, updatedAt: expect.any(String) },
    ]);
    expect(p.templates[0]!.categoryExists).toBe(true);
    for (const n of [2, 3]) {
      const r = await apply(b, adminB, zip, [{ index: 0, action: 'copy', datasourceId: dsB }]);
      expect(r.statusCode).toBe(200);
      expect((r.json() as ImportResult).templates[0]!.name).toBe(`${name} (${n})`);
    }
    const s = await apply(b, adminB, zip, [{ index: 0, action: 'skip' }]);
    expect((s.json() as ImportResult).templates).toEqual([
      { index: 0, action: 'skip', name, id: null },
    ]);
    // Категория создана один раз.
    const cats = await b.deps.db.select().from(categories);
    expect(cats).toHaveLength(1);
  });

  it('update: версия +1, новый docKey, запросы заменены, история запусков на месте', async () => {
    const [before] = await b.deps.db.select().from(templates).where(eq(templates.id, importedId));
    await b.deps.db.insert(reportRuns).values({
      templateId: importedId,
      templateName: name,
      templateVersion: 1,
      userId: adminBId,
      params: {},
      status: 'ok',
      durationMs: 1,
    });
    // Правки в среде B, которые архив перезапишет.
    await b.deps.db.delete(templateQueries).where(eq(templateQueries.templateId, importedId));
    await b.deps.db
      .update(templates)
      .set({ description: 'местное', public: false, lastSaveError: 'x' })
      .where(eq(templates.id, importedId));

    const r = await apply(b, adminB, zip, [
      { index: 0, action: 'update', datasourceId: dsB, targetId: importedId },
    ]);
    expect(r.statusCode).toBe(200);
    expect((r.json() as ImportResult).templates[0]).toEqual({
      index: 0,
      action: 'update',
      name,
      id: importedId,
    });
    const [after] = await b.deps.db.select().from(templates).where(eq(templates.id, importedId));
    expect(after!.version).toBe(before!.version + 1);
    expect(after!.docKey).not.toBe(before!.docKey);
    expect(after!.filePath).toBe(`templates/${importedId}/v2.docx`);
    expect(after).toMatchObject({ description: 'Описание', public: true, lastSaveError: null });
    const qs = await b.deps.db
      .select()
      .from(templateQueries)
      .where(eq(templateQueries.templateId, importedId))
      .orderBy(asc(templateQueries.sortOrder));
    expect(qs.map((q) => q.key)).toEqual(['rows', 'head']);
    const ps = await b.deps.db
      .select()
      .from(templateParams)
      .where(eq(templateParams.templateId, importedId));
    expect(ps).toHaveLength(2);
    const runs = await b.deps.db
      .select()
      .from(reportRuns)
      .where(eq(reportRuns.templateId, importedId));
    expect(runs).toHaveLength(1);
    expect(await b.deps.storage.exists(after!.filePath)).toBe(true);
    await expect.poll(() => b.deps.storage.exists(before!.filePath)).toBe(false);
  });

  it('сбой посреди загрузки: ни одного нового/изменённого шаблона, файлы убраны', async () => {
    // Второй новый шаблон отвергает БД (триггер) — после записи файлов и первых вставок.
    await b.deps.db.execute(sql`
      create function boom() returns trigger language plpgsql as $$
      begin
        if new.name = 'Boom' then raise exception 'boom'; end if;
        return new;
      end $$`);
    await b.deps.db.execute(
      sql`create trigger boom before insert on templates for each row execute function boom()`,
    );
    try {
      const idsA = await Promise.all(
        [`Новый ${randomUUID().slice(0, 4)}`, name, 'Boom'].map(async (n) => {
          const id = await richTemplate(n);
          await a.deps.db
            .update(categories)
            .set({ name: `Новая кат ${n}` })
            .where(
              eq(
                categories.id,
                (await a.deps.db.select().from(templates).where(eq(templates.id, id)))[0]!
                  .categoryId!,
              ),
            );
          return id;
        }),
      );
      const multi = await exportZip(a, adminA, idsA);
      const [before] = await b.deps.db.select().from(templates).where(eq(templates.id, importedId));
      const beforeIds = await dbTemplateIds(b);
      const beforeCats = (await b.deps.db.select().from(categories)).length;

      const r = await apply(b, adminB, multi, [
        { index: 0, action: 'create', datasourceId: dsB },
        { index: 1, action: 'update', datasourceId: dsB, targetId: importedId },
        { index: 2, action: 'create', datasourceId: dsB },
      ]);
      expect(r.statusCode).toBe(500);

      expect(await dbTemplateIds(b)).toEqual(beforeIds);
      const [after] = await b.deps.db.select().from(templates).where(eq(templates.id, importedId));
      expect(after).toEqual(before);
      expect((await b.deps.db.select().from(categories)).length).toBe(beforeCats);
      // Новая версия обновлявшегося шаблона и каталоги несозданных — удалены.
      expect(await b.deps.storage.exists(`templates/${importedId}/v3.docx`)).toBe(false);
      expect(await b.deps.storage.exists(before!.filePath)).toBe(true);
      expect(await storedTemplateIds(b)).toEqual(beforeIds);
    } finally {
      await b.deps.db.execute(sql`drop trigger boom on templates`);
      await b.deps.db.execute(sql`drop function boom()`);
    }
  });

  it('подменённый файл шаблона — 400 IMPORT_INVALID, без записи', async () => {
    const z = await JSZip.loadAsync(zip);
    z.file('templates/1/template.docx', Buffer.from('PK\x03\x04подмена'));
    const bad = await z.generateAsync({ type: 'nodebuffer' });
    const beforeIds = await dbTemplateIds(b);
    for (const r of [
      await preview(b, adminB, bad),
      await apply(b, adminB, bad, [{ index: 0, action: 'copy', datasourceId: dsB }]),
    ]) {
      expect(r.statusCode).toBe(400);
      expect(r.json().error.code).toBe('IMPORT_INVALID');
    }
    expect(await dbTemplateIds(b)).toEqual(beforeIds);
    expect(await storedTemplateIds(b)).toEqual(beforeIds);
  });

  it('несколько шаблонов с тем же именем: все кандидаты, обновляется выбранный', async () => {
    const n = `Двойник ${randomUUID().slice(0, 4)}`;
    const z = await exportZip(a, adminA, [await richTemplate(n)]);
    const ids: string[] = [];
    for (const when of ['2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z']) {
      const id = await createTemplate(b, adminB, dsB);
      await b.deps.db
        .update(templates)
        .set({ name: n, updatedAt: new Date(when) })
        .where(eq(templates.id, id));
      ids.push(id);
    }
    const [older, newer] = ids as [string, string];
    const p = (await preview(b, adminB, z)).json() as ImportPreview;
    expect(p.templates[0]!.existing.map((e) => e.id)).toEqual([newer, older]);
    // Новый — изменён после предпросмотра: обновится всё равно выбранный старый.
    await b.deps.db.update(templates).set({ updatedAt: new Date() }).where(eq(templates.id, older));
    const r = await apply(b, adminB, z, [
      { index: 0, action: 'update', datasourceId: dsB, targetId: older },
    ]);
    expect(r.statusCode).toBe(200);
    expect((r.json() as ImportResult).templates[0]!.id).toBe(older);
    const rows = await b.deps.db.select().from(templates).where(eq(templates.name, n));
    expect(Object.fromEntries(rows.map((x) => [x.id, x.version]))).toEqual({
      [older]: 2,
      [newer]: 1,
    });

    // Переименован или удалён после предпросмотра — 409, без изменений.
    await b.deps.db
      .update(templates)
      .set({ name: `${n}!` })
      .where(eq(templates.id, newer));
    const renamed = await apply(b, adminB, z, [
      { index: 0, action: 'update', datasourceId: dsB, targetId: newer },
    ]);
    expect(renamed.statusCode).toBe(409);
    expect(renamed.json().error.message).toMatch(/изменился после предпросмотра/);
    const del = await b.app.inject({
      method: 'DELETE',
      url: `/api/templates/${newer}`,
      headers: { cookie: adminB },
    });
    expect(del.statusCode).toBe(204);
    const deleted = await apply(b, adminB, z, [
      { index: 0, action: 'update', datasourceId: dsB, targetId: newer },
    ]);
    expect(deleted.statusCode).toBe(409);
    // update без targetId — 400.
    const noTarget = await apply(b, adminB, z, [{ index: 0, action: 'update', datasourceId: dsB }]);
    expect(noTarget.statusCode).toBe(400);
  });

  it('параллельные загрузки одного имени: создаётся один шаблон, вторая — 400', async () => {
    const n = `Гонка ${randomUUID().slice(0, 4)}`;
    const z = await exportZip(a, adminA, [await richTemplate(n)]);
    const rs = await Promise.all(
      [1, 2].map(() => apply(b, adminB, z, [{ index: 0, action: 'create', datasourceId: dsB }])),
    );
    expect(rs.map((r) => r.statusCode).sort()).toEqual([200, 400]);
    expect(await b.deps.db.select().from(templates).where(eq(templates.name, n))).toHaveLength(1);
    expect(await storedTemplateIds(b)).toEqual(await dbTemplateIds(b));
  });

  it('удалённые одновременно группа/категория/источник (нарушение внешнего ключа) — 409, откат', async () => {
    const n = `Ключ ${randomUUID().slice(0, 4)}`;
    const z = await exportZip(a, adminA, [await richTemplate(n)]);
    await b.deps.db.execute(sql`
      create function fk_boom() returns trigger language plpgsql as $$
      begin raise exception 'fk' using errcode = '23503'; end $$`);
    await b.deps.db.execute(
      sql`create trigger fk_boom before insert on template_queries for each row execute function fk_boom()`,
    );
    try {
      const before = await dbTemplateIds(b);
      const r = await apply(b, adminB, z, [{ index: 0, action: 'create', datasourceId: dsB }]);
      expect(r.statusCode).toBe(409);
      expect(r.json().error.code).toBe('CONFLICT');
      expect(await dbTemplateIds(b)).toEqual(before);
      expect(await storedTemplateIds(b)).toEqual(before);
    } finally {
      await b.deps.db.execute(sql`drop trigger fk_boom on template_queries`);
      await b.deps.db.execute(sql`drop function fk_boom()`);
    }
  });
});
