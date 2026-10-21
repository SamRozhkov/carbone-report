import { randomUUID } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ImportDecision,
  ImportPreview,
  ImportResult,
} from '@carbone-reports/shared/template-transfer';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { categories, groups, templateEditors, templateGroups, templates } from '../src/db/schema';
import {
  createSourceDatabase,
  createTemplate,
  createTestApp,
  listKeys,
  loginAs,
  multipart,
  type TestApp,
} from './helpers';

// Загрузка шаблонов из архива (§33.2) для роли «Редактор» (§43.3).
let t: TestApp;
let admin: string;
let adminId: string;
let editorA: { cookie: string; id: string };
let manager: string;
let dsId: string;

const call = (method: 'GET' | 'POST' | 'PATCH', url: string, cookie: string, payload?: object) =>
  t.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });

async function exportZip(cookie: string, ids: string[]): Promise<Buffer> {
  const r = await call('POST', '/api/templates/export', cookie, { ids });
  expect(r.statusCode, r.body).toBe(200);
  return r.rawPayload;
}

const preview = (cookie: string, zip: Buffer) => {
  const body = multipart({}, { name: 'x.crt.zip', data: zip });
  return t.app.inject({
    method: 'POST',
    url: '/api/templates/import/preview',
    headers: { cookie, ...body.headers },
    payload: body.payload,
  });
};

const apply = (cookie: string, zip: Buffer, decisions: ImportDecision[]) => {
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

/** Пути файлов шаблона в хранилище. */
async function storedPaths(id: string): Promise<string[]> {
  if (t.deps.config.s3) {
    const keys = await listKeys(t.deps.config.s3);
    return keys.filter((k) => k.startsWith(`templates/${id}/`));
  }
  const dir = join(t.deps.config.storageDir, 'templates', id);
  return (await readdir(dir, { recursive: true }).catch(() => [] as string[])).sort();
}

async function row(id: string) {
  const [r] = await t.deps.db.select().from(templates).where(eq(templates.id, id));
  return r!;
}

async function groupIdsOf(id: string): Promise<string[]> {
  const rs = await t.deps.db
    .select({ groupId: templateGroups.groupId })
    .from(templateGroups)
    .where(eq(templateGroups.templateId, id))
    .orderBy(asc(templateGroups.groupId));
  return rs.map((r) => r.groupId);
}

const decision = (over: Partial<ImportDecision> = {}): ImportDecision => ({
  index: 0,
  action: 'create',
  datasourceId: dsId,
  targetId: null,
  targetUpdatedAt: null,
  ...over,
});

/** Шаблон администратора X с категорией (затем удалённой) и группой; архив выгружает admin. */
let foreignX: string;
let foreignXName: string;
let groupId: string;
let zipX: Buffer;

beforeAll(async () => {
  t = await createTestApp();
  const la = await loginAs(t, 'admin');
  admin = la.cookie;
  adminId = la.user.id;
  const a = await loginAs(t, 'editor');
  editorA = { cookie: a.cookie, id: a.user.id };
  manager = (await loginAs(t, 'access_manager')).cookie;
  const src = await createSourceDatabase('select 1');
  const ds = await call('POST', '/api/datasources', admin, {
    name: 'Учёт',
    ...src,
    sslMode: 'disable',
  });
  dsId = ds.json().id;

  foreignX = await createTemplate(t, admin, dsId);
  foreignXName = `Чужой ${randomUUID().slice(0, 8)}`;
  const [cat] = await t.deps.db
    .insert(categories)
    .values({ name: `Новая ${randomUUID().slice(0, 8)}` })
    .returning();
  const [g] = await t.deps.db
    .insert(groups)
    .values({ name: `Группа ${randomUUID().slice(0, 8)}` })
    .returning();
  groupId = g!.id;
  await t.deps.db
    .update(templates)
    .set({ name: foreignXName, categoryId: cat!.id })
    .where(eq(templates.id, foreignX));
  await t.deps.db.insert(templateGroups).values({ templateId: foreignX, groupId });
  zipX = await exportZip(admin, [foreignX]);
  await t.deps.db.delete(categories).where(eq(categories.id, cat!.id));
});
afterAll(() => t?.close());

describe('загрузка из архива редактором (§43.3)', () => {
  it('чужой шаблон не виден в existing; категория не создаётся; create — 409, copy — свой шаблон', async () => {
    const catsBefore = await t.deps.db.select().from(categories);
    const p = await preview(editorA.cookie, zipX);
    expect(p.statusCode, p.body).toBe(200);
    const item = (p.json() as ImportPreview).templates[0]!;
    expect(item.existing).toEqual([]);
    expect(item).toMatchObject({ categoryExists: false, categorySkipped: true });

    const created = await apply(editorA.cookie, zipX, [decision()]);
    expect(created.statusCode, created.body).toBe(409);

    const copied = await apply(editorA.cookie, zipX, [decision({ action: 'copy' })]);
    expect(copied.statusCode, copied.body).toBe(200);
    const [res] = (copied.json() as ImportResult).templates;
    expect(res).toMatchObject({ action: 'copy', name: `${foreignXName} (2)` });
    const r = await row(res!.id!);
    expect(r).toMatchObject({ ownerId: editorA.id, categoryId: null });
    expect(await groupIdsOf(r.id)).toEqual([groupId]);
    // Категория не создана.
    expect(await t.deps.db.select().from(categories)).toHaveLength(catsBefore.length);
  });

  it('свой шаблон и выданный в редакторы — в existing, чужой с тем же именем — нет; update сохраняет владельца', async () => {
    const name = `Свой ${randomUUID().slice(0, 8)}`;
    const created = await call('POST', '/api/templates', editorA.cookie, {
      name,
      datasourceId: dsId,
      blank: 'docx',
    });
    expect(created.statusCode, created.body).toBe(201);
    const own: string = created.json().id;
    // Шаблоны администратора с тем же именем: один выдан A в редакторы, другой — нет.
    const granted = await createTemplate(t, admin, dsId);
    const hidden = await createTemplate(t, admin, dsId);
    await t.deps.db.update(templates).set({ name }).where(eq(templates.id, granted));
    await t.deps.db.update(templates).set({ name }).where(eq(templates.id, hidden));
    await t.deps.db.insert(templateEditors).values({ templateId: granted, userId: editorA.id });

    const zip = await exportZip(editorA.cookie, [own]);
    const changed = await call('PATCH', `/api/templates/${own}`, editorA.cookie, {
      description: 'изменено',
    });
    expect(changed.statusCode, changed.body).toBe(200);

    const p = await preview(editorA.cookie, zip);
    expect(p.statusCode, p.body).toBe(200);
    const item = (p.json() as ImportPreview).templates[0]!;
    expect(item.existing.map((e) => e.id).sort()).toEqual([own, granted].sort());
    expect(item.categorySkipped).toBe(false);
    const target = item.existing.find((e) => e.id === own)!;

    const r = await apply(editorA.cookie, zip, [
      decision({ action: 'update', targetId: own, targetUpdatedAt: target.updatedAt }),
    ]);
    expect(r.statusCode, r.body).toBe(200);
    expect(await row(own)).toMatchObject({ ownerId: editorA.id, description: '' });
  });

  it('подделанный update чужого шаблона — 403 до записи файлов', async () => {
    const adminView = (await preview(admin, zipX)).json() as ImportPreview;
    const stamp = adminView.templates[0]!.existing.find((e) => e.id === foreignX)!.updatedAt;
    const before = await row(foreignX);
    const filesBefore = await storedPaths(foreignX);

    const r = await apply(editorA.cookie, zipX, [
      decision({ action: 'update', targetId: foreignX, targetUpdatedAt: stamp }),
    ]);
    expect(r.statusCode, r.body).toBe(403);
    expect(r.json().error.message).toBe('нет права на правку шаблона');
    expect(await storedPaths(foreignX)).toEqual(filesBefore);
    const after = await row(foreignX);
    expect(after.version).toBe(before.version);
    expect(after.filePath).toBe(before.filePath);
  });

  it('admin: отсутствующая категория создаётся, владелец новых шаблонов — admin', async () => {
    const p = await preview(admin, zipX);
    expect(p.statusCode, p.body).toBe(200);
    const item = (p.json() as ImportPreview).templates[0]!;
    expect(item).toMatchObject({ categoryExists: false, categorySkipped: false });
    expect(item.existing.map((e) => e.id)).toContain(foreignX);

    const r = await apply(admin, zipX, [decision({ action: 'copy' })]);
    expect(r.statusCode, r.body).toBe(200);
    const created = await row((r.json() as ImportResult).templates[0]!.id!);
    expect(created.ownerId).toBe(adminId);
    expect(created.categoryId).not.toBeNull();
    const [cat] = await t.deps.db
      .select()
      .from(categories)
      .where(eq(categories.id, created.categoryId!));
    expect(cat!.name).toMatch(/^Новая /);
  });

  it('access_manager — предпросмотр и загрузка 403', async () => {
    expect((await preview(manager, zipX)).statusCode).toBe(403);
    expect((await apply(manager, zipX, [decision({ action: 'copy' })])).statusCode).toBe(403);
  });
});
