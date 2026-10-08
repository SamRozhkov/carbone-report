import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertKnownMigration, bundledMigrationHashes, FUTURE_BACKUP } from './migrations';

/** Те же миграции, что Dockerfile копирует в /agent/drizzle. */
const folder = fileURLToPath(new URL('../../api/drizzle', import.meta.url));

describe('миграции в образе', () => {
  it('хеши — sha256 SQL-файлов в порядке журнала, как в drizzle.__drizzle_migrations', async () => {
    const journal = JSON.parse(await readFile(join(folder, 'meta/_journal.json'), 'utf8')) as {
      entries: { tag: string }[];
    };
    const expected = await Promise.all(
      journal.entries.map(async (e) =>
        createHash('sha256')
          .update(await readFile(join(folder, `${e.tag}.sql`), 'utf8'))
          .digest('hex'),
      ),
    );
    expect(expected.length).toBeGreaterThanOrEqual(7);
    expect(bundledMigrationHashes(folder)).toEqual(expected);
  });

  it('assertKnownMigration: известная — ок, неизвестная — «из будущего», нет версии — отказ', () => {
    const known = bundledMigrationHashes(folder);
    expect(() => assertKnownMigration(known[0]!, known)).not.toThrow();
    expect(() => assertKnownMigration('f'.repeat(64), known)).toThrow(FUTURE_BACKUP);
    expect(() => assertKnownMigration(null, known)).toThrow(
      'в manifest.txt нет last_migration: версия схемы бэкапа неизвестна',
    );
  });
});
