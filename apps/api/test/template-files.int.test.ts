import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { eq, sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { templates } from '../src/db/schema';
import { STORAGE_REMOVE_LOCK_KEY } from '../src/lib/storage-gate';
import { createBlankDocument } from '../src/modules/templates/blank';
import { migrateTemplateFiles } from '../src/modules/templates/file-migration';
import { discardUncommittedFile, templateFileRef } from '../src/modules/templates/service';
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
let dsId: string;

beforeAll(async () => {
  t = await createTestApp();
  admin = (await loginAs(t, 'admin')).cookie;
  const src = await createSourceDatabase('select 1');
  dsId = (
    await t.app.inject({
      method: 'POST',
      url: '/api/datasources',
      headers: { cookie: admin },
      payload: { name: 's', ...src, sslMode: 'disable' },
    })
  ).json().id;
});
afterAll(() => t.close());

const rowOf = async (id: string) =>
  (await t.deps.db.select().from(templates).where(eq(templates.id, id)))[0]!;

/** Удаление прежнего файла идёт в фоне: ждём результат не дольше 2 с. */
async function eventually(check: () => Promise<void>, ms = 2000) {
  const until = Date.now() + ms;
  for (;;) {
    try {
      return await check();
    } catch (err) {
      if (Date.now() >= until) throw err;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

async function putFile(id: string, data: Buffer) {
  const mp = multipart({}, { name: 'x.docx', data });
  return t.app.inject({
    method: 'PUT',
    url: `/api/templates/${id}/file`,
    headers: { cookie: admin, ...mp.headers },
    payload: mp.payload,
  });
}

describe('файлы шаблонов по версиям', () => {
  it('новый шаблон хранится в templates/<id>/v1.<ext>', async () => {
    const id = await createTemplate(t, admin, dsId);
    expect((await rowOf(id)).filePath).toBe(`templates/${id}/v1.docx`);
  });

  it('PUT /file пишет новую версию в новый путь и удаляет старый файл', async () => {
    const id = await createTemplate(t, admin, dsId);
    const r = await putFile(id, await createBlankDocument('docx'));
    expect(r.statusCode).toBe(200);
    const row = await rowOf(id);
    expect(row.version).toBe(2);
    expect(row.filePath).toBe(`templates/${id}/v2.docx`);
    expect(await t.deps.storage.exists(`templates/${id}/v2.docx`)).toBe(true);
    await eventually(async () =>
      expect(await t.deps.storage.exists(`templates/${id}/v1.docx`)).toBe(false),
    );
  });

  it('сбой транзакции после записи файла: версия и путь прежние, старый файл на месте', async () => {
    const id = await createTemplate(t, admin, dsId);
    const before = await rowOf(id);
    const original = await t.deps.storage.read(before.filePath);
    // Принудительный сбой UPDATE: триггер, который бросает исключение для этой строки.
    await t.deps.db.execute(
      sql.raw(`
      create or replace function cr_fail() returns trigger as $$ begin raise exception 'boom'; end $$ language plpgsql;
      create trigger cr_fail_tr before update on templates for each row
        when (old.id = '${id}') execute function cr_fail();`),
    );
    try {
      const replacement = Buffer.concat([await createBlankDocument('docx'), Buffer.from('new')]);
      const r = await putFile(id, replacement);
      expect(r.statusCode).toBe(500);
    } finally {
      await t.deps.db.execute(
        sql.raw('drop trigger cr_fail_tr on templates; drop function cr_fail();'),
      );
    }
    const after = await rowOf(id);
    expect(after.version).toBe(before.version);
    expect(after.filePath).toBe(before.filePath);
    expect(await t.deps.storage.exists(before.filePath)).toBe(true);
    // Новый файл-сирота убран
    expect(await t.deps.storage.exists(`templates/${id}/v${before.version + 1}.docx`)).toBe(false);
    // Отчёт по-прежнему собирается из прежнего файла, его содержимое не тронуто
    expect((await t.deps.storage.read(after.filePath)).equals(original)).toBe(true);
  });

  it('удаление шаблона удаляет каталог со всеми версиями', async () => {
    const id = await createTemplate(t, admin, dsId);
    await t.deps.storage.write(`templates/${id}/orphan.tmp`, Buffer.from('x'));
    const r = await t.app.inject({
      method: 'DELETE',
      url: `/api/templates/${id}`,
      headers: { cookie: admin },
    });
    expect(r.statusCode).toBe(204);
    expect(await t.deps.storage.exists(`templates/${id}/v1.docx`)).toBe(false);
    expect(await t.deps.storage.exists(`templates/${id}/orphan.tmp`)).toBe(false);
    // Каталог версий исчез целиком (rm -rf), а не только файлы в нём.
    await expect(access(join(t.deps.config.storageDir, 'templates', id))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('дублирование копирует текущую версию в templates/<новый id>/v1', async () => {
    const id = await createTemplate(t, admin, dsId);
    await putFile(id, await createBlankDocument('docx'));
    const r = await t.app.inject({
      method: 'POST',
      url: `/api/templates/${id}/duplicate`,
      headers: { cookie: admin },
    });
    const copy = await rowOf(r.json().id);
    expect(copy.filePath).toBe(`templates/${copy.id}/v1.docx`);
    expect(await t.deps.storage.exists(copy.filePath)).toBe(true);
  });
  it('отчёт, начатый до сохранения новой версии, читает актуальный файл, а не удалённый прежний', async () => {
    const id = await createTemplate(t, admin, dsId);
    const before = await rowOf(id);
    const ref = templateFileRef(t.deps, before); // снимок строки до замены
    const replacement = Buffer.concat([await createBlankDocument('docx'), Buffer.from('v2')]);
    expect((await putFile(id, replacement)).statusCode).toBe(200);
    // Прежний файл удаляется в фоне — дожидаемся, чтобы проверить переход на актуальный.
    await eventually(async () => expect(await t.deps.storage.exists(before.filePath)).toBe(false));
    expect((await ref.read()).equals(replacement)).toBe(true);
  });
  it('скачивание и дублирование переживают гонку с заменой файла (ENOENT на прежнем пути)', async () => {
    const id = await createTemplate(t, admin, dsId);
    const replacement = Buffer.concat([await createBlankDocument('docx'), Buffer.from('v2')]);
    expect((await putFile(id, replacement)).statusCode).toBe(200);
    const current = (await rowOf(id)).filePath;
    // Строка прочитана до коммита: первое чтение по пути из строки падает, как после удаления файла.
    const failOnce = () => {
      const real = t.deps.storage.read.bind(t.deps.storage);
      let failed = false;
      return vi.spyOn(t.deps.storage, 'read').mockImplementation(async (path) => {
        if (!failed && path === current) {
          failed = true;
          throw Object.assign(new Error('gone'), { code: 'ENOENT' });
        }
        return real(path);
      });
    };
    const spy = failOnce();
    const dl = await t.app.inject({
      method: 'GET',
      url: `/api/templates/${id}/download`,
      headers: { cookie: admin },
    });
    spy.mockRestore();
    expect(dl.statusCode).toBe(200);
    expect(dl.rawPayload.equals(replacement)).toBe(true);
    const spy2 = failOnce();
    const dup = await t.app.inject({
      method: 'POST',
      url: `/api/templates/${id}/duplicate`,
      headers: { cookie: admin },
    });
    spy2.mockRestore();
    expect(dup.statusCode).toBe(201);
  });
});

describe('шлюз удалений', () => {
  it('удаление шаблона во время бэкапа ждёт снятия блокировки', async () => {
    const id = await createTemplate(t, admin, dsId);
    const path = (await rowOf(id)).filePath;
    const holder = new pg.Client({ connectionString: t.deps.config.databaseUrl });
    await holder.connect();
    try {
      await holder.query('select pg_advisory_lock($1)', [STORAGE_REMOVE_LOCK_KEY]);
      const del = t.app.inject({
        method: 'DELETE',
        url: `/api/templates/${id}`,
        headers: { cookie: admin },
      });
      await new Promise((r) => setTimeout(r, 300));
      expect(await t.deps.storage.exists(path)).toBe(true);
      await holder.query('select pg_advisory_unlock($1)', [STORAGE_REMOVE_LOCK_KEY]);
      expect((await del).statusCode).toBe(204);
      expect(await t.deps.storage.exists(path)).toBe(false);
    } finally {
      await holder.end();
    }
  });
});

describe('шлюз удалений: изоляция и неблокирующий путь', () => {
  const bounded = <T>(p: Promise<T>, ms: number, msg: string) =>
    Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(msg)), ms))]);

  it('ожидающие удаления не занимают основной пул', async ({ onTestFinished }) => {
    const holder = new pg.Client({ connectionString: t.deps.config.databaseUrl });
    await holder.connect();
    await holder.query('select pg_advisory_lock($1)', [STORAGE_REMOVE_LOCK_KEY]);
    // Всегда выполняется: снимает блокировку, чтобы ожидающие удаления завершились, и закрывает соединение.
    onTestFinished(async () => {
      await holder.end();
    });
    const removes = Array.from({ length: 12 }, (_, i) => t.deps.storage.remove(`gate/${i}.bin`));
    await new Promise((r) => setTimeout(r, 200));
    await bounded(
      t.deps.db.execute(sql`select 1`),
      1500,
      'основной пул занят ожидающими удалениями',
    );
    await holder.query('select pg_advisory_unlock($1)', [STORAGE_REMOVE_LOCK_KEY]);
    await Promise.all(removes);
  });

  it('PUT /file во время бэкапа отвечает сразу; старый файл удаляется после снятия блокировки', async ({
    onTestFinished,
  }) => {
    const id = await createTemplate(t, admin, dsId);
    const old = (await rowOf(id)).filePath;
    const holder = new pg.Client({ connectionString: t.deps.config.databaseUrl });
    await holder.connect();
    await holder.query('select pg_advisory_lock($1)', [STORAGE_REMOVE_LOCK_KEY]);
    onTestFinished(async () => {
      await holder.end(); // сессия закрыта — блокировка снята
    });
    const r = await bounded(
      putFile(id, await createBlankDocument('docx')),
      1500,
      'PUT /file ждёт окончания бэкапа',
    );
    expect(r.statusCode).toBe(200);
    expect((await rowOf(id)).filePath).toBe(`templates/${id}/v2.docx`);
    expect(await t.deps.storage.exists(old)).toBe(true);
    await holder.query('select pg_advisory_unlock($1)', [STORAGE_REMOVE_LOCK_KEY]);
    await eventually(async () => expect(await t.deps.storage.exists(old)).toBe(false));
  });

  it('discardUncommittedFile при бэкапе не ждёт даже при занятом пуле шлюза и оставляет сироту', async ({
    onTestFinished,
  }) => {
    const id = await createTemplate(t, admin, dsId);
    const orphan = `templates/${id}/v99.docx`;
    await t.deps.storage.write(orphan, Buffer.from('x'));
    const holder = new pg.Client({ connectionString: t.deps.config.databaseUrl });
    await holder.connect();
    await holder.query('select pg_advisory_lock($1)', [STORAGE_REMOVE_LOCK_KEY]);
    onTestFinished(async () => {
      await holder.end(); // сессия закрыта — блокировка снята, ожидающие удаления завершатся
    });
    // Оба соединения пула шлюза (max 2) заняты ожидающими удалениями.
    const waiters = [0, 1, 2].map((i) => t.deps.storage.remove(`gate/w${i}.bin`));
    await new Promise((r) => setTimeout(r, 200));
    const warns: string[] = [];
    await bounded(
      discardUncommittedFile(t.deps, id, orphan, { warn: (m) => warns.push(m) }),
      1500,
      'discardUncommittedFile ждёт бэкап',
    );
    expect(await t.deps.storage.exists(orphan)).toBe(true);
    expect(warns).toEqual([`идёт бэкап — файл-сирота оставлен: ${orphan}`]);
    await holder.query('select pg_advisory_unlock($1)', [STORAGE_REMOVE_LOCK_KEY]);
    await Promise.all(waiters);
    // Без бэкапа сирота убирается.
    await discardUncommittedFile(t.deps, id, orphan);
    expect(await t.deps.storage.exists(orphan)).toBe(false);
  });
});

describe('перенос старых путей при старте', () => {
  it('переносит templates/<id>.<ext> в templates/<id>/v<version>.<ext>, идемпотентно, без файла — не падает', async () => {
    const a = await createTemplate(t, admin, dsId);
    const b = await createTemplate(t, admin, dsId);
    const data = await t.deps.storage.read((await rowOf(a)).filePath);
    // Имитация старого формата: файл по старому пути, строка указывает на него; версия 3.
    await t.deps.storage.write(`templates/${a}.docx`, data);
    await t.deps.db
      .update(templates)
      .set({ filePath: `templates/${a}.docx`, version: 3 })
      .where(eq(templates.id, a));
    // b: старый путь, но файла нет
    await t.deps.db
      .update(templates)
      .set({ filePath: `templates/${b}.docx` })
      .where(eq(templates.id, b));

    const warnings: unknown[] = [];
    const log = { warn: (o: unknown) => void warnings.push(o), info: () => undefined };
    expect(await migrateTemplateFiles({ db: t.deps.db, storage: t.deps.storage, log })).toBe(1);
    const ra = await rowOf(a);
    expect(ra.filePath).toBe(`templates/${a}/v3.docx`);
    expect(await t.deps.storage.exists(ra.filePath)).toBe(true);
    expect((await t.deps.storage.read(ra.filePath)).equals(data)).toBe(true);
    expect(await t.deps.storage.exists(`templates/${a}.docx`)).toBe(false);
    expect((await rowOf(b)).filePath).toBe(`templates/${b}.docx`); // не тронут, только предупреждение
    expect(warnings).toEqual([{ templateId: b, filePath: `templates/${b}.docx` }]);

    expect(await migrateTemplateFiles({ db: t.deps.db, storage: t.deps.storage })).toBe(0);
  });
});
