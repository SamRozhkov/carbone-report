import type { Role } from '@carbone-reports/shared';
import { eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { datasources, templateEditors, templates, users } from '../src/db/schema';
import {
  assertTemplateEdit,
  assertTemplateOwner,
  canEditTemplate,
} from '../src/modules/access/permissions';
import { makeGuards } from '../src/modules/auth/guards';
import type { SessionUser } from '../src/modules/auth/session';
import { createTestApp, loginAs, type TestApp } from './helpers';

interface Actor {
  cookie: string;
  user: SessionUser;
}

let t: TestApp;
let dsId: string;
let tplId: string;
const actors = {} as Record<
  'admin' | 'owner' | 'granted' | 'other' | 'accessManager' | 'plain',
  Actor
>;
const MISSING = '00000000-0000-4000-8000-000000000000';

async function actor(role: Role): Promise<Actor> {
  const { cookie, user } = await loginAs(t, role);
  return { cookie, user: { id: user.id, login: user.login, role: user.role } };
}

async function insertTemplate(ownerId: string | null): Promise<string> {
  const [row] = await t.deps.db
    .insert(templates)
    .values({
      name: `T ${Math.random()}`,
      datasourceId: dsId,
      fileExt: 'docx',
      filePath: 'templates/x.docx',
      docKey: `k${Math.random()}`,
      ownerId,
    })
    .returning();
  return row!.id;
}

const status = (p: Promise<unknown>) =>
  p.then(
    () => 200,
    (e: { status?: number }) => e.status ?? 500,
  );

/** Права по actor: [canEditTemplate, assertTemplateEdit, assertTemplateOwner]. */
async function rights(a: Actor, id = tplId): Promise<[boolean, number, number]> {
  const db = t.deps.db;
  return [
    await canEditTemplate(db, a.user, id),
    await status(assertTemplateEdit(db, a.user, id)),
    await status(assertTemplateOwner(db, a.user, id)),
  ];
}

/** Вызов preHandler так, как его вызывает Fastify: cookie сессии и params маршрута. */
async function guard(
  name: 'requireTemplateEdit' | 'requireTemplateOwner',
  a: Actor,
  id = tplId,
): Promise<number> {
  const [cookieName, value] = a.cookie.split('=') as [string, string];
  const req = { cookies: { [cookieName]: value }, params: { id } } as unknown as FastifyRequest;
  return status(makeGuards(t.deps)[name](req, {} as FastifyReply));
}

beforeAll(async () => {
  t = await createTestApp();
  const [ds] = await t.deps.db
    .insert(datasources)
    .values({ name: 's', host: 'h', port: 5432, database: 'd', username: 'u', passwordEnc: 'x' })
    .returning();
  dsId = ds!.id;
  actors.admin = await actor('admin');
  actors.owner = await actor('editor');
  actors.granted = await actor('editor');
  actors.other = await actor('editor');
  actors.accessManager = await actor('access_manager');
  actors.plain = await actor('user');
  tplId = await insertTemplate(actors.owner.user.id);
  await t.deps.db
    .insert(templateEditors)
    .values({ templateId: tplId, userId: actors.granted.user.id });
});
afterAll(() => t.close());

describe('права на шаблон (§43.1)', () => {
  it('закрытый шаблон: правят admin, владелец и выданный; прочим он не виден — 404', async () => {
    expect(await rights(actors.admin)).toEqual([true, 200, 200]);
    expect(await rights(actors.owner)).toEqual([true, 200, 200]);
    expect(await rights(actors.granted)).toEqual([true, 200, 403]);
    expect(await rights(actors.other)).toEqual([false, 404, 404]);
    expect(await rights(actors.accessManager)).toEqual([false, 404, 404]);
    expect(await rights(actors.plain)).toEqual([false, 404, 404]);
  });

  it('несуществующий шаблон — 404 для всех, включая admin', async () => {
    for (const a of Object.values(actors)) {
      expect(await rights(a, MISSING)).toEqual([false, 404, 404]);
    }
  });

  it('шаблон без владельца правит только admin', async () => {
    const id = await insertTemplate(null);
    await t.deps.db.update(templates).set({ public: true }).where(eq(templates.id, id));
    expect(await rights(actors.admin, id)).toEqual([true, 200, 200]);
    expect(await rights(actors.owner, id)).toEqual([false, 403, 403]);
  });

  it('guards: роль, затем право правки или владения', async () => {
    expect(await guard('requireTemplateEdit', actors.admin)).toBe(200);
    expect(await guard('requireTemplateEdit', actors.granted)).toBe(200);
    expect(await guard('requireTemplateOwner', actors.owner)).toBe(200);
    expect(await guard('requireTemplateOwner', actors.granted)).toBe(403);
    expect(await guard('requireTemplateEdit', actors.other)).toBe(404);
    // Роль без права правки отсекается до проверки шаблона: 403, а не 404.
    expect(await guard('requireTemplateEdit', actors.accessManager)).toBe(403);
    expect(await guard('requireTemplateEdit', actors.plain)).toBe(403);
    expect(await guard('requireTemplateEdit', actors.admin, MISSING)).toBe(404);
  });

  it('шаблон «доступен всем»: видящим его без права правки — 403', async () => {
    await t.deps.db.update(templates).set({ public: true }).where(eq(templates.id, tplId));
    expect(await rights(actors.other)).toEqual([false, 403, 403]);
    expect(await rights(actors.accessManager)).toEqual([false, 403, 403]);
    expect(await rights(actors.plain)).toEqual([false, 403, 403]);
    await expect(assertTemplateEdit(t.deps.db, actors.other.user, tplId)).rejects.toMatchObject({
      status: 403,
      message: 'нет права на правку шаблона',
    });
  });

  it('пониженный до user редактор теряет право сразу, запись в template_editors остаётся', async () => {
    const demoted = await actor('editor');
    await t.deps.db.insert(templateEditors).values({ templateId: tplId, userId: demoted.user.id });
    expect(await guard('requireTemplateEdit', demoted)).toBe(200);
    await t.deps.db.update(users).set({ role: 'user' }).where(eq(users.id, demoted.user.id));
    expect(await guard('requireTemplateEdit', demoted)).toBe(403);
    expect(await canEditTemplate(t.deps.db, { ...demoted.user, role: 'user' }, tplId)).toBe(false);
    const rows = await t.deps.db
      .select()
      .from(templateEditors)
      .where(eq(templateEditors.userId, demoted.user.id));
    expect(rows).toHaveLength(1);
  });
});

describe('каскады миграции 0015', () => {
  it('удаление владельца обнуляет owner_id', async () => {
    const owner = await actor('editor');
    const id = await insertTemplate(owner.user.id);
    await t.deps.db.delete(users).where(eq(users.id, owner.user.id));
    const [row] = await t.deps.db.select().from(templates).where(eq(templates.id, id));
    expect(row!.ownerId).toBeNull();
  });

  it('удаление шаблона или пользователя удаляет строки template_editors', async () => {
    const id = await insertTemplate(actors.owner.user.id);
    const editor = await actor('editor');
    await t.deps.db.insert(templateEditors).values([
      { templateId: id, userId: actors.granted.user.id },
      { templateId: id, userId: editor.user.id },
    ]);
    await t.deps.db.delete(users).where(eq(users.id, editor.user.id));
    const left = await t.deps.db
      .select()
      .from(templateEditors)
      .where(eq(templateEditors.templateId, id));
    expect(left.map((r) => r.userId)).toEqual([actors.granted.user.id]);
    await t.deps.db.delete(templates).where(eq(templates.id, id));
    const after = await t.deps.db
      .select()
      .from(templateEditors)
      .where(eq(templateEditors.templateId, id));
    expect(after).toHaveLength(0);
  });
});
