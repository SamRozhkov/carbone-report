import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from '../src/db/client';
import { createTestApp, createTestDatabase, type TestApp } from './helpers';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

describe('база данных', () => {
  it('миграции создали все таблицы', async () => {
    const r = await t.deps.db.execute<{ table_name: string }>(
      sql`select table_name from information_schema.tables where table_schema = 'public' order by 1`,
    );
    expect(r.rows.map((x) => x.table_name)).toEqual(
      expect.arrayContaining([
        'datasources',
        'report_run_files',
        'report_runs',
        'template_params',
        'template_queries',
        'templates',
        'users',
      ]),
    );
  });
  it('GET /api/health работает', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.json()).toEqual({ status: 'ok' });
  });
});

describe('миграция 0013_oidc', () => {
  it('логины, отличающиеся только регистром, — понятная ошибка вместо нарушения индекса', async () => {
    // База в состоянии до 0013: миграции 0000–0012 из копии каталога с усечённым журналом.
    const dir = join(import.meta.dirname, '../drizzle');
    const before = await mkdtemp(join(tmpdir(), 'cr-mig-'));
    try {
      await cp(dir, before, { recursive: true });
      const journalPath = join(before, 'meta/_journal.json');
      const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
        entries: { tag: string }[];
      };
      journal.entries = journal.entries.filter((e) => e.tag < '0013_');
      await writeFile(journalPath, JSON.stringify(journal));

      const url = await createTestDatabase();
      const { db, pool } = createDb(url);
      try {
        await migrate(db, { migrationsFolder: before });
        await db.execute(
          sql`insert into users (login, password_hash, role) values ('Ivan', 'x', 'user'), ('ivan', 'x', 'user'), ('petrov', 'x', 'user')`,
        );
        // drizzle оборачивает ошибку Postgres («Failed query: …»), текст RAISE — в cause.
        const err = await migrate(db, { migrationsFolder: dir }).then(
          () => null,
          (e: unknown) => e as Error & { cause?: Error },
        );
        expect(err?.cause?.message).toBe(
          'логины, отличающиеся только регистром: Ivan, ivan; переименуйте их перед обновлением (docs/operations/keycloak.md)',
        );
        // Миграция откатилась целиком: таблиц OIDC нет, прежнее ограничение на месте.
        const r = await db.execute<{ n: number }>(
          sql`select count(*)::int as n from information_schema.tables where table_name = 'oidc_sessions'`,
        );
        expect(r.rows[0]!.n).toBe(0);

        // После переименования миграция проходит.
        await db.execute(sql`update users set login = 'ivan2' where login = 'Ivan'`);
        await migrate(db, { migrationsFolder: dir });
        const [u] = (
          await db.execute<{ auth_source: string }>(
            sql`select auth_source from users where login = 'ivan'`,
          )
        ).rows;
        expect(u!.auth_source).toBe('local');
      } finally {
        await pool.end();
      }
    } finally {
      await rm(before, { recursive: true, force: true });
    }
  });
});
