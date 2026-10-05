import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { expect, it } from 'vitest';
import { createTestDatabase } from './helpers';

it('миграция ssl → ssl_mode: true → require, false → disable', async () => {
  const client = new pg.Client({ connectionString: await createTestDatabase() });
  await client.connect();
  try {
    // Таблица в форме до миграции (только колонки, которые затрагивает 0002).
    await client.query(
      `create table datasources (id serial primary key, ssl boolean not null default false)`,
    );
    await client.query(`insert into datasources (ssl) values (true), (false)`);
    const dir = join(import.meta.dirname, '../drizzle');
    const file = (await readdir(dir)).find((f) => f.startsWith('0002_'))!;
    const sqlText = await readFile(join(dir, file), 'utf8');
    for (const stmt of sqlText.split('--> statement-breakpoint')) {
      if (stmt.trim()) await client.query(stmt);
    }
    const { rows } = await client.query(`select id, ssl_mode, ssl_ca from datasources order by id`);
    expect(rows).toEqual([
      { id: 1, ssl_mode: 'require', ssl_ca: null },
      { id: 2, ssl_mode: 'disable', ssl_ca: null },
    ]);
  } finally {
    await client.end();
  }
});
