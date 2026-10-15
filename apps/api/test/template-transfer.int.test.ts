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
  templateAttachments,
  templateCharts,
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
import { makePdf } from '../src/modules/pdf/test-pdf';

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

/** `existing[].updatedAt` шаблона `id` из предпросмотра — как его передаёт окно загрузки. */
async function stamp(zip: Buffer, id: string, index = 0): Promise<string> {
  const p = (await preview(b, adminB, zip)).json() as ImportPreview;
  return p.templates[index]!.existing.find((e) => e.id === id)!.updatedAt;
}

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
  const charts = await a.app.inject({
    method: 'PUT',
    url: `/api/templates/${id}/charts`,
    headers: { cookie: adminA },
    payload: [
      {
        key: 'sales',
        query: 'rows',
        type: 'bar',
        category: 'x',
        series: [{ column: 'x', color: '#123456' }],
        title: 'Продажи',
      },
    ],
  });
  if (charts.statusCode !== 200) throw new Error(charts.body);
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
    const g = await b.app.inject({
      method: 'GET',
      url: `/api/templates/${importedId}`,
      headers: { cookie: adminB },
    });
    expect(g.json().charts).toEqual([
      expect.objectContaining({
        key: 'sales',
        query: 'rows',
        title: 'Продажи',
        series: [{ column: 'x', color: '#123456' }],
      }),
    ]);
    expect((m1.templates as { charts: unknown[] }[])[0]!.charts).toHaveLength(1);
  });

  it('create при существующем имени — 409; copy — «(2)», затем «(3)»; skip', async () => {
    const dup = await apply(b, adminB, zip, [{ index: 0, action: 'create', datasourceId: dsB }]);
    expect(dup.statusCode).toBe(409);
    const p = (await preview(b, adminB, zip)).json() as ImportPreview;
    expect(p.templates[0]!.existing).toEqual([
      { id: importedId, name, updatedAt: expect.stringMatching(/^\d{4}-.+T.+\.\d{6}Z$/) },
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
      .update(templateCharts)
      .set({ key: 'local' })
      .where(eq(templateCharts.templateId, importedId));
    await b.deps.db
      .update(templates)
      .set({ description: 'местное', public: false, lastSaveError: 'x' })
      .where(eq(templates.id, importedId));

    const r = await apply(b, adminB, zip, [
      {
        index: 0,
        action: 'update',
        datasourceId: dsB,
        targetId: importedId,
        targetUpdatedAt: await stamp(zip, importedId),
      },
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
    const cs = await b.deps.db
      .select()
      .from(templateCharts)
      .where(eq(templateCharts.templateId, importedId));
    expect(cs.map((c) => c.key)).toEqual(['sales']);
    const runs = await b.deps.db
      .select()
      .from(reportRuns)
      .where(eq(reportRuns.templateId, importedId));
    expect(runs).toHaveLength(1);
    expect(await b.deps.storage.exists(after!.filePath)).toBe(true);
    await expect.poll(() => b.deps.storage.exists(before!.filePath)).toBe(false);
  });

  it('update архивом без charts: графики шаблона удалены, запрос charts допустим', async () => {
    const z = await JSZip.loadAsync(zip);
    const m = JSON.parse(await z.file('manifest.json')!.async('string'));
    delete m.templates[0].charts;
    m.templates[0].queries[1].key = 'charts';
    z.file('manifest.json', JSON.stringify(m));
    const noCharts = await z.generateAsync({ type: 'nodebuffer' });
    const before = await b.deps.db
      .select()
      .from(templateCharts)
      .where(eq(templateCharts.templateId, importedId));
    expect(before).toHaveLength(1);
    const r = await apply(b, adminB, noCharts, [
      {
        index: 0,
        action: 'update',
        datasourceId: dsB,
        targetId: importedId,
        targetUpdatedAt: await stamp(noCharts, importedId),
      },
    ]);
    expect(r.statusCode).toBe(200);
    expect(
      await b.deps.db
        .select()
        .from(templateCharts)
        .where(eq(templateCharts.templateId, importedId)),
    ).toEqual([]);
    const qs = await b.deps.db
      .select()
      .from(templateQueries)
      .where(eq(templateQueries.templateId, importedId));
    expect(qs.map((q) => q.key).sort()).toEqual(['charts', 'rows']);
    // Исходный архив возвращает график и запрос head.
    const back = await apply(b, adminB, zip, [
      {
        index: 0,
        action: 'update',
        datasourceId: dsB,
        targetId: importedId,
        targetUpdatedAt: await stamp(zip, importedId),
      },
    ]);
    expect(back.statusCode).toBe(200);
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
        {
          index: 1,
          action: 'update',
          datasourceId: dsB,
          targetId: importedId,
          targetUpdatedAt: await stamp(multi, importedId, 1),
        },
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
    const at = (id: string) => p.templates[0]!.existing.find((e) => e.id === id)!.updatedAt;
    // Не выбранный (новый) изменён после предпросмотра: обновляется выбранный старый.
    await b.deps.db.update(templates).set({ updatedAt: new Date() }).where(eq(templates.id, newer));
    const r = await apply(b, adminB, z, [
      {
        index: 0,
        action: 'update',
        datasourceId: dsB,
        targetId: older,
        targetUpdatedAt: at(older),
      },
    ]);
    expect(r.statusCode).toBe(200);
    expect((r.json() as ImportResult).templates[0]!.id).toBe(older);
    const rows = await b.deps.db.select().from(templates).where(eq(templates.name, n));
    expect(Object.fromEntries(rows.map((x) => [x.id, x.version]))).toEqual({
      [older]: 2,
      [newer]: 1,
    });

    // Переименован или удалён после предпросмотра — 409, без изменений.
    const newerAt = await stamp(z, newer);
    await b.deps.db
      .update(templates)
      .set({ name: `${n}!` })
      .where(eq(templates.id, newer));
    const renamed = await apply(b, adminB, z, [
      { index: 0, action: 'update', datasourceId: dsB, targetId: newer, targetUpdatedAt: newerAt },
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
      { index: 0, action: 'update', datasourceId: dsB, targetId: newer, targetUpdatedAt: newerAt },
    ]);
    expect(deleted.statusCode).toBe(409);
    // update без targetId — 400.
    const noTarget = await apply(b, adminB, z, [{ index: 0, action: 'update', datasourceId: dsB }]);
    expect(noTarget.statusCode).toBe(400);
  });

  it('параллельные загрузки одного имени: создаётся один шаблон, вторая — 409', async () => {
    const n = `Гонка ${randomUUID().slice(0, 4)}`;
    const z = await exportZip(a, adminA, [await richTemplate(n)]);
    const rs = await Promise.all(
      [1, 2].map(() => apply(b, adminB, z, [{ index: 0, action: 'create', datasourceId: dsB }])),
    );
    expect(rs.map((r) => r.statusCode).sort()).toEqual([200, 409]);
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

  it.each([
    ['запросы', 'queries'],
    ['параметры', 'params'],
    ['доступ', 'access'],
    ['файл (как сохранение OnlyOffice)', 'file'],
  ])('шаблон изменён после предпросмотра (%s) — 409, без изменений', async (_, what) => {
    const n = `Правка ${randomUUID().slice(0, 4)}`;
    const z = await exportZip(a, adminA, [await richTemplate(n)]);
    const created = await apply(b, adminB, z, [{ index: 0, action: 'create', datasourceId: dsB }]);
    const id = (created.json() as ImportResult).templates[0]!.id!;
    const at = await stamp(z, id);
    const put = (url: string, payload: unknown) =>
      b.app.inject({ method: 'PUT', url, headers: { cookie: adminB }, payload: payload as object });
    if (what === 'queries') {
      // Запрос графика удалить нельзя — меняем SQL.
      const edited = [
        { key: 'rows', sql: 'select 3 as x', mode: 'list' },
        { key: 'head', sql: 'select 2 as y', mode: 'single' },
      ];
      expect((await put(`/api/templates/${id}/queries`, edited)).statusCode).toBe(200);
    } else if (what === 'params') {
      expect((await put(`/api/templates/${id}/params`, [])).statusCode).toBe(200);
    } else if (what === 'access') {
      const r = await put(`/api/templates/${id}/access`, {
        public: false,
        categoryId: null,
        groupIds: [],
      });
      expect(r.statusCode).toBe(200);
    } else {
      const zipFile = await JSZip.loadAsync(z);
      const data = Buffer.from(
        await zipFile.file('templates/1/template.docx')!.async('uint8array'),
      );
      const body = multipart({}, { name: 'x.docx', data });
      const r = await b.app.inject({
        method: 'PUT',
        url: `/api/templates/${id}/file`,
        headers: { cookie: adminB, ...body.headers },
        payload: body.payload,
      });
      expect(r.statusCode).toBe(200);
    }
    const [before] = await b.deps.db.select().from(templates).where(eq(templates.id, id));
    const r = await apply(b, adminB, z, [
      { index: 0, action: 'update', datasourceId: dsB, targetId: id, targetUpdatedAt: at },
    ]);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.message).toBe(
      `шаблон «${n}» изменился после предпросмотра — повторите предпросмотр`,
    );
    const [after] = await b.deps.db.select().from(templates).where(eq(templates.id, id));
    expect(after).toEqual(before);
    // С новым предпросмотром — проходит.
    const ok = await apply(b, adminB, z, [
      {
        index: 0,
        action: 'update',
        datasourceId: dsB,
        targetId: id,
        targetUpdatedAt: await stamp(z, id),
      },
    ]);
    expect(ok.statusCode).toBe(200);
  });

  it('настройки PDF и приложения: выгрузка → создание → обновление; подмена приложения — 400 (§36.6)', async () => {
    const pdfName = `PDF ${randomUUID().slice(0, 6)}`;
    const srcId = await createTemplate(a, adminA, dsA);
    await a.app.inject({
      method: 'PATCH',
      url: `/api/templates/${srcId}`,
      headers: { cookie: adminA },
      payload: { name: pdfName },
    });
    const put = await a.app.inject({
      method: 'PUT',
      url: `/api/templates/${srcId}/pdf-options`,
      headers: { cookie: adminA },
      payload: { watermark: { text: 'КОПИЯ' }, pageNumbers: {} },
    });
    expect(put.statusCode).toBe(200);
    const uploadTo = async (
      t: TestApp,
      cookie: string,
      id: string,
      name: string,
      pages: number,
      placement: string,
    ) => {
      const data = Buffer.from(
        await makePdf(Array.from({ length: pages }, (_, i) => ({ label: `P${i}` }))),
      );
      const m = multipart({ placement }, { name, data });
      const r = await t.app.inject({
        method: 'POST',
        url: `/api/templates/${id}/attachments`,
        headers: { cookie, ...m.headers },
        payload: m.payload,
      });
      expect(r.statusCode).toBe(201);
    };
    await uploadTo(a, adminA, srcId, 'Титул.pdf', 2, 'start');
    await uploadTo(a, adminA, srcId, 'Условия.pdf', 1, 'end');

    // 1. Выгрузка: манифест с настройками и путями приложений, файлы в архиве.
    const z = await exportZip(a, adminA, [srcId]);
    const m = await manifestOf(z);
    const t0 = (m.templates as Record<string, unknown>[])[0]!;
    expect(t0.pdfOptions).toMatchObject({ pdfa: false, watermark: { text: 'КОПИЯ' } });
    expect(t0.attachments).toEqual([
      expect.objectContaining({
        file: 'templates/1/attachments/1.pdf',
        name: 'Титул.pdf',
        placement: 'start',
      }),
      expect.objectContaining({
        file: 'templates/1/attachments/2.pdf',
        name: 'Условия.pdf',
        placement: 'end',
      }),
    ]);
    const zz = await JSZip.loadAsync(z);
    expect(zz.file('templates/1/attachments/1.pdf')).not.toBeNull();

    // 2. Создание в среде B: те же настройки и приложения, файлы под новым id.
    const created = await apply(b, adminB, z, [{ index: 0, action: 'create', datasourceId: dsB }]);
    expect(created.statusCode).toBe(200);
    const newId = (created.json() as ImportResult).templates[0]!.id!;
    const card = (
      await b.app.inject({ url: `/api/templates/${newId}`, headers: { cookie: adminB } })
    ).json();
    expect(card.pdfOptions.watermark.text).toBe('КОПИЯ');
    expect(
      card.attachments.map((x: { name: string; placement: string; pages: number }) => [
        x.name,
        x.placement,
        x.pages,
      ]),
    ).toEqual([
      ['Титул.pdf', 'start', 2],
      ['Условия.pdf', 'end', 1],
    ]);
    const rows = await b.deps.db
      .select()
      .from(templateAttachments)
      .where(eq(templateAttachments.templateId, newId));
    for (const r of rows) {
      expect(r.filePath.startsWith(`templates/${newId}/attachments/`)).toBe(true);
      expect(await b.deps.storage.exists(r.filePath)).toBe(true);
    }

    // 3. Обновление шаблона с другим приложением: прежнее приложение и его файл удалены.
    await b.app.inject({
      method: 'DELETE',
      url: `/api/templates/${newId}/attachments/${rows[0]!.id}`,
      headers: { cookie: adminB },
    });
    await uploadTo(b, adminB, newId, 'Старое.pdf', 1, 'end');
    const [old] = await b.deps.db
      .select()
      .from(templateAttachments)
      .where(eq(templateAttachments.name, 'Старое.pdf'));
    const updated = await apply(b, adminB, z, [
      {
        index: 0,
        action: 'update',
        datasourceId: dsB,
        targetId: newId,
        targetUpdatedAt: await stamp(z, newId),
      },
    ]);
    expect(updated.statusCode).toBe(200);
    const after = (
      await b.app.inject({ url: `/api/templates/${newId}`, headers: { cookie: adminB } })
    ).json();
    expect(after.attachments.map((x: { name: string }) => x.name)).toEqual([
      'Титул.pdf',
      'Условия.pdf',
    ]);
    await expect.poll(() => b.deps.storage.exists(old!.filePath)).toBe(false);

    // 4. Подменённое приложение (содержимое и sha256 согласованы, но это не PDF) — 400, без записи.
    const bad = await JSZip.loadAsync(z);
    const fake = Buffer.from('PK\x03\x04 подмена');
    bad.file('templates/1/attachments/1.pdf', fake);
    const bm = JSON.parse(await bad.file('manifest.json')!.async('string'));
    const { createHash } = await import('node:crypto');
    bm.templates[0].attachments[0].sha256 = createHash('sha256').update(fake).digest('hex');
    bad.file('manifest.json', JSON.stringify(bm));
    const badZip = await bad.generateAsync({ type: 'nodebuffer' });
    const beforeIds = await dbTemplateIds(b);
    const r = await apply(b, adminB, badZip, [{ index: 0, action: 'copy', datasourceId: dsB }]);
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatchObject({
      code: 'IMPORT_INVALID',
      message: `шаблон «${pdfName}»: файл «Титул.pdf»: файл не PDF`,
    });
    expect(await dbTemplateIds(b)).toEqual(beforeIds);
  });
});
