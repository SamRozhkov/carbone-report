import { describe, expect, it } from 'vitest';
import { checkReadOnlySql, FORBIDDEN_SQL_FUNCTIONS } from './sql-readonly';

describe('checkReadOnlySql: разрешено', () => {
  it.each([
    'SELECT 1',
    'select 1',
    'with a as (select 1 as x) select x from a',
    'VALUES (1)',
    'table t',
    '(select 1) union (select 2)',
    'select 1; -- конец',
    'select 1;   /* хвост */  ',
    "select case when x > 0 then 'a' else 'b' end from t",
    'select start, "end", comment, set_name from t',
    "select 'update delete insert into drop pg_sleep(1)' as s",
    "select E'it\\'s update' as s",
    'select $$ delete from t $$ as s',
    'select $x$ insert into t $x$ as s',
    'select 1 -- update t set a = 1\n',
    'select 1 /* delete /* nested */ from t */',
    'select "update", "delete", "into" from t',
    'select updated_at, into_date, deleted from t',
    'select my_pg_sleep_report(1), lower(name), local_x from t',
    'select * from t where a = :update and b = :into',
    'select a[1:2] from t',
    'select x::text from t',
    'select substring(s for 3) from t',
    'select * from "pg_sleep"',
    'select U&"d\\0061ta" from t',
  ])('%s', (sql) => {
    expect(checkReadOnlySql(sql)).toEqual({ ok: true });
  });
});

describe('checkReadOnlySql: запрещено', () => {
  it.each<[string, string]>([
    ['ALTER TABLE t ADD c int', 'ALTER'],
    ['update t set a = 1', 'UPDATE'],
    ['create table x (a int)', 'CREATE'],
    ['drop table t', 'DROP'],
    ['insert into t values (1)', 'INSERT'],
    ['delete from t', 'DELETE'],
    ['truncate t', 'TRUNCATE'],
    ['grant select on t to u', 'GRANT'],
    ['copy t to stdout', 'COPY'],
    ['do $$ begin end $$', 'DO'],
    ['call p()', 'CALL'],
    ['set search_path = x', 'SET'],
    ['lock t', 'LOCK'],
    ['begin', 'BEGIN'],
    ['commit', 'COMMIT'],
    ['explain analyze delete from t', 'EXPLAIN'],
    ['"select" 1', '"select"'],
    ['select 1; select 2', ';'],
    ['select 1;;', ';'],
    ['select 1; drop table t', ';'],
    ['with d as (delete from t returning *) select * from d', 'DELETE'],
    ['with u as (update t set a = 1 returning *) select * from u', 'UPDATE'],
    ['with i as (insert into t values (1) returning *) select * from i', 'INSERT'],
    ['with m as (merge into t using s on true when matched then do nothing) select 1', 'MERGE'],
    ['select * into x from t', 'INTO'],
    ['select update from t', 'UPDATE'],
    ['select * from t for update', 'FOR UPDATE'],
    ['select * from t FOR no key UPDATE', 'FOR NO KEY UPDATE'],
    ['select * from t for share', 'FOR SHARE'],
    ['select * from t for key share', 'FOR KEY SHARE'],
    ['select pg_sleep(1)', 'pg_sleep'],
    ['select pg_catalog.pg_sleep(1)', 'pg_sleep'],
    ['select "pg_sleep"(1)', 'pg_sleep'],
    ['select PG_SLEEP (1)', 'pg_sleep'],
    ['select pg_sleep/**/(1)', 'pg_sleep'],
    ['select pg_sleep_for(1)', 'pg_sleep_for'],
    ['select "pg_catalog"."PG_SLEEP"(1)', 'pg_sleep'],
    ["select nextval('s')", 'nextval'],
    ["select query_to_xml('delete from t', true, true, '')", 'query_to_xml'],
    [';', ';'],
    ["select (a)[1 :nextval('s')]", 'nextval'],
    ['select (a)[:pg_sleep(1)]', 'pg_sleep'],
    ['select U&"pg_\\0073leep"(1)', 'pg_sleep'],
    ['select u&"pg_sl\\+000065ep"(1)', 'pg_sleep'],
    ['select U&"x!0061" UESCAPE \'!\' from t', 'UESCAPE'],
    ['', ''],
    ['   ', ''],
    ['-- только комментарий', ''],
  ])('%s → %s', (sql, found) => {
    expect(checkReadOnlySql(sql)).toEqual({ ok: false, found });
  });
});

/** Пример имени для шаблона: '*' → 'x'. */
const sample = (p: string) => p.replaceAll('*', 'x');

describe('FORBIDDEN_SQL_FUNCTIONS', () => {
  it.each(FORBIDDEN_SQL_FUNCTIONS.map((p) => [p, sample(p)]))(
    '%s: вызов %s запрещён',
    (_p, name) => {
      expect(checkReadOnlySql(`select ${name}(1)`)).toEqual({ ok: false, found: name });
    },
  );

  it('содержит все группы §47.1', () => {
    for (const name of [
      'dblink',
      'dblink_exec',
      'pg_terminate_backend',
      'pg_cancel_backend',
      'pg_reload_conf',
      'pg_rotate_logfile',
      'pg_promote',
      'pg_log_backend_memory_contexts',
      'pg_advisory_lock',
      'pg_advisory_xact_lock_shared',
      'pg_try_advisory_lock',
      'set_config',
      'pg_read_file',
      'pg_read_binary_file',
      'pg_ls_dir',
      'pg_ls_waldir',
      'pg_stat_file',
      'lo_import',
      'lo_export',
      'loread',
      'lowrite',
      'pg_sleep',
      'pg_sleep_until',
      'nextval',
      'setval',
      'pg_notify',
      'txid_current',
      'pg_current_xact_id',
      'pg_current_xact_id_if_assigned',
      'query_to_xml',
      'query_to_xmlschema',
      'query_to_xml_and_xmlschema',
      'cursor_to_xml',
      'table_to_xml',
      'database_to_xml',
      'schema_to_xml',
      'pg_create_restore_point',
      'pg_switch_wal',
      'pg_start_backup',
      'pg_backup_start',
      'pg_stop_backup',
      'pg_backup_stop',
      'pg_create_logical_replication_slot',
      'pg_drop_replication_slot',
      'pg_replication_origin_create',
      'pg_import_system_collations',
    ]) {
      expect(checkReadOnlySql(`select ${name}(1)`), name).toEqual({ ok: false, found: name });
    }
  });

  it('похожие безопасные имена не задеты', () => {
    for (const name of [
      'lower',
      'local_fn',
      'my_pg_sleep_report',
      'set_name',
      'txid',
      'pg_size_pretty',
    ])
      expect(checkReadOnlySql(`select ${name}(1)`), name).toEqual({ ok: true });
  });
});
