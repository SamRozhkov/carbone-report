// Схема источника для авторов (§51.2): только системный каталог, только отношения с SELECT.
import type {
  RelationKind,
  SchemaColumn,
  SchemaForeignKey,
  SchemaTableDetails,
  SchemaTableList,
} from '@carbone-reports/shared';
import type pg from 'pg';

const KINDS: Record<string, RelationKind> = {
  r: 'table',
  p: 'table',
  v: 'view',
  m: 'matview',
  f: 'foreign',
};
const MAX_TABLES = 100;
const MAX_COLUMNS = 300;

const RELATIONS = `
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  where c.relkind in ('r','p','v','m','f')
    and n.nspname not in ('pg_catalog', 'information_schema')
    and n.nspname not like 'pg\\_toast%' and n.nspname not like 'pg\\_temp%'
    and pg_catalog.has_table_privilege(c.oid, 'SELECT')`;

/**
 * Поиск — подстрока без учёта регистра в имени или комментарии. Сравнение в коде, а не ILIKE:
 * у источника с локалью C регистр кириллицы не сворачивается, а % и _ должны быть буквами.
 */
export async function listTables(client: pg.ClientBase, search?: string): Promise<SchemaTableList> {
  const q = search?.trim().toLocaleLowerCase() || null;
  const { rows } = await client.query<{
    schema: string;
    name: string;
    kind: string;
    comment: string | null;
  }>(
    `select n.nspname as schema, c.relname as name, c.relkind as kind,
            pg_catalog.obj_description(c.oid, 'pg_class') as comment
     ${RELATIONS}
     order by n.nspname <> all (pg_catalog.current_schemas(false)), c.relname, n.nspname`,
  );
  const found =
    q === null
      ? rows
      : rows.filter(
          (r) =>
            r.name.toLocaleLowerCase().includes(q) ||
            (r.comment?.toLocaleLowerCase().includes(q) ?? false),
        );
  return {
    total: found.length,
    tables: found.slice(0, MAX_TABLES).map((r) => ({
      schema: r.schema,
      name: r.name,
      kind: KINDS[r.kind]!,
      comment: r.comment,
    })),
  };
}

/** `таблица` или `схема.таблица`; без схемы — первая доступная по search_path. null — нет доступной. */
export async function describeTable(
  client: pg.ClientBase,
  ref: string,
): Promise<SchemaTableDetails | null> {
  const dot = ref.indexOf('.');
  const schema = dot > 0 ? ref.slice(0, dot) : null;
  const name = dot > 0 ? ref.slice(dot + 1) : ref;
  const { rows: rel } = await client.query<{
    oid: number;
    schema: string;
    name: string;
    kind: string;
    comment: string | null;
  }>(
    `select c.oid::int as oid, n.nspname as schema, c.relname as name, c.relkind as kind,
            pg_catalog.obj_description(c.oid, 'pg_class') as comment
     ${RELATIONS}
       and c.relname = $2
       and (case when $1::text is null then n.nspname = any (pg_catalog.current_schemas(false)) else n.nspname = $1 end)
     order by pg_catalog.array_position(pg_catalog.current_schemas(false), n.nspname::text)
     limit 1`,
    [schema, name],
  );
  const t = rel[0];
  if (!t) return null;
  const { rows: cols } = await client.query<SchemaColumn>(
    `select a.attname as name, pg_catalog.format_type(a.atttypid, a.atttypmod) as type,
            a.attnotnull as "notNull", pg_catalog.col_description(a.attrelid, a.attnum) as comment
     from pg_catalog.pg_attribute a
     where a.attrelid = $1 and a.attnum > 0 and not a.attisdropped
     order by a.attnum limit ${MAX_COLUMNS}`,
    [t.oid],
  );
  const { rows: pk } = await client.query<{ name: string }>(
    `select a.attname as name
     from pg_catalog.pg_index i
     join pg_catalog.pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
     where i.indrelid = $1 and i.indisprimary
     order by pg_catalog.array_position(i.indkey::int2[], a.attnum)`,
    [t.oid],
  );
  const { rows: fks } = await client.query<{
    columns: string[];
    ref_schema: string;
    ref_table: string;
    ref_columns: string[];
  }>(
    `select array(select a.attname from unnest(k.conkey) with ordinality u(n, o)
                  join pg_catalog.pg_attribute a on a.attrelid = k.conrelid and a.attnum = u.n order by u.o)::text[] as columns,
            rn.nspname as ref_schema, rc.relname as ref_table,
            array(select a.attname from unnest(k.confkey) with ordinality u(n, o)
                  join pg_catalog.pg_attribute a on a.attrelid = k.confrelid and a.attnum = u.n order by u.o)::text[] as ref_columns
     from pg_catalog.pg_constraint k
     join pg_catalog.pg_class rc on rc.oid = k.confrelid
     join pg_catalog.pg_namespace rn on rn.oid = rc.relnamespace
     where k.conrelid = $1 and k.contype = 'f'
     order by k.conname`,
    [t.oid],
  );
  return {
    schema: t.schema,
    name: t.name,
    kind: KINDS[t.kind]!,
    comment: t.comment,
    columns: cols,
    primaryKey: pk.map((r) => r.name),
    foreignKeys: fks.map((f): SchemaForeignKey => ({
      columns: f.columns,
      references: { schema: f.ref_schema, table: f.ref_table, columns: f.ref_columns },
    })),
  };
}
