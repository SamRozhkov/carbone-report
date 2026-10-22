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

describe('миграция 0014_gost_signature', () => {
  it('существующие подписи — method = p12; запуски с положением штампа — sign_method = p12', async () => {
    // База в состоянии до 0014: миграции 0000–0013 из копии каталога с усечённым журналом.
    const dir = join(import.meta.dirname, '../drizzle');
    const before = await mkdtemp(join(tmpdir(), 'cr-mig-'));
    try {
      await cp(dir, before, { recursive: true });
      const journalPath = join(before, 'meta/_journal.json');
      const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
        entries: { tag: string }[];
      };
      journal.entries = journal.entries.filter((e) => e.tag < '0014_');
      await writeFile(journalPath, JSON.stringify(journal));

      const url = await createTestDatabase();
      const { db, pool } = createDb(url);
      try {
        await migrate(db, { migrationsFolder: before });
        const [u] = (
          await db.execute<{ id: string }>(
            sql`insert into users (login, password_hash, role) values ('ivan', 'x', 'user') returning id`,
          )
        ).rows;
        const run = (pos: string | null) =>
          db.execute<{ id: string }>(
            sql`insert into report_runs (template_name, template_version, user_id, params, status, snapshot, signature_position, duration_ms)
                values ('T', 1, ${u!.id}, '{}'::jsonb, 'ok', true, ${pos}, 1) returning id`,
          );
        const signed = (await run('bottom-left')).rows[0]!.id;
        const allowed = (await run('bottom-right')).rows[0]!.id;
        const plain = (await run(null)).rows[0]!.id;
        await db.execute(
          sql`insert into report_run_signatures (run_id, user_id, signer_cn, fingerprint, signed_at, timestamped, file_path)
              values (${signed}, ${u!.id}, 'CN', 'AA', now(), false, ${`reports/${signed}/out.signed.pdf`})`,
        );

        await migrate(db, { migrationsFolder: dir });

        const sigs = await db.execute<{ method: string; sig_path: string | null }>(
          sql`select method, sig_path from report_run_signatures`,
        );
        expect(sigs.rows).toEqual([{ method: 'p12', sig_path: null }]);
        const runs = await db.execute<{ id: string; sign_method: string | null }>(
          sql`select id, sign_method from report_runs`,
        );
        expect(Object.fromEntries(runs.rows.map((r) => [r.id, r.sign_method]))).toEqual({
          [signed]: 'p12',
          [allowed]: 'p12',
          [plain]: null,
        });
        // Неизвестный способ отклоняется ограничением.
        await expect(
          db.execute(sql`update report_run_signatures set method = 'x'`),
        ).rejects.toThrow();
        const pending = await db.execute<{ n: number }>(
          sql`select count(*)::int as n from information_schema.tables where table_name = 'gost_sign_pending'`,
        );
        expect(pending.rows[0]!.n).toBe(1);
      } finally {
        await pool.end();
      }
    } finally {
      await rm(before, { recursive: true, force: true });
    }
  });
});

describe('миграция 0017_report_locale', () => {
  it('шаблоны — ru, прежний формат нумерации удалён, другие форматы не тронуты; у запусков — NULL', async () => {
    // База в состоянии до 0017: миграции 0000–0016 из копии каталога с усечённым журналом.
    const dir = join(import.meta.dirname, '../drizzle');
    const before = await mkdtemp(join(tmpdir(), 'cr-mig-'));
    try {
      await cp(dir, before, { recursive: true });
      const journalPath = join(before, 'meta/_journal.json');
      const journal = JSON.parse(await readFile(journalPath, 'utf8')) as {
        entries: { tag: string }[];
      };
      journal.entries = journal.entries.filter((e) => e.tag < '0017_');
      await writeFile(journalPath, JSON.stringify(journal));

      const url = await createTestDatabase();
      const { db, pool } = createDb(url);
      try {
        await migrate(db, { migrationsFolder: before });
        const [u] = (
          await db.execute<{ id: string }>(
            sql`insert into users (login, password_hash, role) values ('ivan', 'x', 'user') returning id`,
          )
        ).rows;
        const [ds] = (
          await db.execute<{ id: string }>(
            sql`insert into datasources (name, host, port, database, username, password_enc)
                values ('s', 'h', 5432, 'd', 'u', 'x') returning id`,
          )
        ).rows;
        const options = {
          ruDefault: {
            pdfa: true,
            pageNumbers: {
              format: 'Стр. {page} из {pages}',
              position: 'top-right',
              skipFirst: true,
            },
          },
          en: {
            pageNumbers: { format: 'Page {page}', position: 'bottom-center', skipFirst: false },
          },
          ruOwn: {
            pageNumbers: {
              format: ' Стр. {page} из {pages} и др.',
              position: 'bottom-right',
              skipFirst: false,
            },
          },
          none: { watermark: { text: 'КОПИЯ', opacity: 20, color: 'gray', angle: 'diagonal' } },
          empty: {},
        };
        for (const [name, o] of Object.entries(options))
          await db.execute(
            sql`insert into templates (name, datasource_id, file_ext, file_path, doc_key, pdf_options)
                values (${name}, ${ds!.id}, 'docx', ${`templates/${name}/v1.docx`}, ${name}, ${JSON.stringify(o)}::jsonb)`,
          );
        await db.execute(
          sql`insert into report_runs (template_name, template_version, user_id, params, status, duration_ms)
              values ('T', 1, ${u!.id}, '{}'::jsonb, 'ok', 1)`,
        );

        await migrate(db, { migrationsFolder: dir });

        const tpls = await db.execute<{ name: string; report_locale: string; pdf_options: object }>(
          sql`select name, report_locale, pdf_options from templates`,
        );
        expect(Object.fromEntries(tpls.rows.map((r) => [r.name, r.pdf_options]))).toEqual({
          ...options,
          ruDefault: { pdfa: true, pageNumbers: { position: 'top-right', skipFirst: true } },
        });
        expect(new Set(tpls.rows.map((r) => r.report_locale))).toEqual(new Set(['ru']));
        const runs = await db.execute<{ report_locale: string | null }>(
          sql`select report_locale from report_runs`,
        );
        expect(runs.rows).toEqual([{ report_locale: null }]);
        // Новый шаблон без явного значения — тоже 'ru' (умолчание колонки).
        const [fresh] = (
          await db.execute<{ report_locale: string }>(
            sql`insert into templates (name, datasource_id, file_ext, file_path, doc_key)
                values ('new', ${ds!.id}, 'docx', 'templates/new/v1.docx', 'new') returning report_locale`,
          )
        ).rows;
        expect(fresh!.report_locale).toBe('ru');
      } finally {
        await pool.end();
      }
    } finally {
      await rm(before, { recursive: true, force: true });
    }
  });
});
