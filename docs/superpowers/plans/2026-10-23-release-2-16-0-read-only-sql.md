# 2.16.0: только запросы на чтение — план

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** запросы шаблона и запросы списков значений параметров могут только читать данные: статическая проверка SQL при сохранении, импорте, выгрузке и перед выполнением.

**Architecture:** общий сканер SQL (`scanSql`) переезжает в shared и используется и `parseSqlParams` (API), и новой `checkReadOnlySql`. Проверка встраивается в схемы zod `TemplateQuery.sql` и `refineTemplateParam` — этим покрыты сохранение (`PUT …/queries`, `PUT …/params`), импорт (`TransferQuery`/`TransferParam` берут те же правила → `IMPORT_INVALID`) и выгрузка (манифест проверяется той же схемой). В `executor.ts` та же проверка выполняется до `pool.connect()` — для запросов, сохранённых до 2.16.0, и для «Выполнить» в редакторе. Транзакция `READ ONLY` и guard остаются вторым рубежом.

**Tech Stack:** TypeScript, zod 4, Fastify, pg, vitest, i18next-каталоги в `packages/shared/src/i18n/<locale>/*.json`.

**Spec:** `docs/superpowers/specs/2026-10-02-carbone-reports-design.md`, §47 (строка ~2193). Исполнители читают §47 целиком.

## Global Constraints

- Ветка `feat/2.16.0` (уже создана от main `59cf151`); не переключать ветки, не пушить, не мержить.
- Без новых зависимостей.
- `found` — найденное слово в верхнем регистре или имя функции в нижнем регистре без схемы; `;` — для второй команды.
- Ключи и тексты (`ru` — дословно из §47.2):
  - `validation` → `sql.readOnlyOnly`: «Разрешены только запросы на чтение (SELECT); найдено: {{found}}. Если это имя колонки, возьмите его в двойные кавычки»
  - `errors` → `sql.notReadOnly`: «{{what}}: разрешены только запросы на чтение (SELECT); найдено: {{found}}»
- Тексты на 7 языках (`ru, en, es, pt-BR, fr, de, zh-CN`); `pnpm i18n:check` зелёный.
- Node: `export PATH=$HOME/.nvm/versions/node/v22.17.0/bin:$PATH`.
- Тестовые наборы не запускать параллельно; `render-onlyoffice.int.test.ts` не запускать никогда.
- Коммиты заканчиваются абзацем:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01QhpYjvmQgUdZAFnqrogAEB
  ```
- Не читать и не печатать `.env`, `certs/`.

## Решения при составлении плана

- **Справка по шаблонам не меняется.** §47.3 требует абзац «в разделе о запросах, если такой раздел есть»; в справке (`apps/web/src/pages/admin/help/content/*.ts`) такого раздела нет (разделы: basics, tables, formatting, conditions, aggregates, totals, media, charts, echarts, html, pdf, signature, unavailable).
- **Веб-код не меняется.** `DataTab` уже показывает `own['sql']` под редактором SQL, `ParamsTab` — `errorFor(i, 'sql')`; задача 4 добавляет тест, закрепляющий это для нового сообщения.
- **Пустой запрос** (только пробелы и комментарии) — `{ ok: false, found: '' }`. Сохранение пустого SQL и так отклоняется (`min(1)`, `v:param.sqlRequired`), до этой ветки доходит только текст из одних комментариев.
- **Второй рубеж в тестах.** Тесты `executor.int.test.ts` и `reports.int.test.ts`, которые проверяют READ ONLY, guard, таймауты и обрыв соединения, сейчас пишут `pg_sleep`, `insert`, `commit`, `set_config`, `pg_advisory_lock` прямо в SQL. После 2.16.0 такие запросы отклоняются статически. Опасные вызовы переносятся в функции исходной БД (`sleep_for`, `write_company`, `evil_path`, `lock42`, `no_timeout`): статическая проверка их пропускает, и второй рубеж по-прежнему проверяется настоящей БД. Выход из транзакции (`commit`/`rollback`/`end`/`abort`) из текста SQL теперь недостижим, эти тесты проверяют статический отказ. Проверка `transaction_timestamp` в guard остаётся защитой без теста, который до неё доходит.

## Review Focus

1. Колонка или таблица с запрещённым словом без кавычек (`select update from t`, `select x.into from x`) — отказ с подсказкой про двойные кавычки. С кавычками (`"update"`) — проходит. Тест — задача 2.
2. Запрещённое слово внутри строки, комментария или долларовой строки, в том числе незакрытой (`select 'a` …, `/* /* */` без второго `*/`) — сканер не падает, слово внутри не считается. Тест — задача 2.
3. Шаблон, сохранённый до 2.16.0, с изменяющим запросом: формирование, предпросмотр данных и список значений отвечают `400 SQL_ERROR` без подключения к источнику. Выгрузка такого шаблона отвечает `400` с путём `queries.N.sql`, а не `500`. Тест — задачи 3 и 4.
4. Смешанный набор: первый запрос шаблона допустим, второй нет. Отказ приходит до соединения, первый запрос не выполняется. Тест — задача 3 (модульный, поддельный пул).
5. Демо-шаблон «Счёт (демо)» (`demo/template.ts`: `DEMO_QUERIES`, `DEMO_PARAMS`) сохраняется без ошибок. Тест — задача 4.

---

### Task 1: общий сканер SQL в shared

**Files:**
- Create: `packages/shared/src/sql-scan.ts`
- Create: `packages/shared/src/sql-scan.test.ts`
- Modify: `packages/shared/src/index.ts` (экспорт)
- Modify: `apps/api/src/modules/queries/sql-params.ts` (использовать `scanSql`)
- Test (без изменений, регрессия): `apps/api/src/modules/queries/sql-params.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type SqlSegmentKind = 'code' | 'lineComment' | 'blockComment' | 'string' | 'quotedIdent' | 'dollarString';
  export interface SqlSegment { kind: SqlSegmentKind; start: number; end: number } // [start, end) в исходной строке
  export function scanSql(sql: string): SqlSegment[];
  ```
  Участки идут подряд и покрывают всю строку без пропусков: `segments[0].start === 0`, `segments[k].end === segments[k+1].start`, последний `end === sql.length`. Пустая строка → `[]`. Соседние участки `code` не дробятся: между двумя некодовыми участками не больше одного `code`. Префикс `E` у `E'…'` остаётся в `code`, участок `string` начинается с `'`.

- [ ] **Step 1: тест сканера**

`packages/shared/src/sql-scan.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { scanSql, type SqlSegment } from './sql-scan';

const parts = (sql: string) =>
  scanSql(sql).map((s: SqlSegment) => [s.kind, sql.slice(s.start, s.end)]);

describe('scanSql', () => {
  it('пустая строка — нет участков', () => {
    expect(scanSql('')).toEqual([]);
  });

  it('только код — один участок', () => {
    expect(parts('select 1')).toEqual([['code', 'select 1']]);
  });

  it('комментарии, строки, идентификаторы в кавычках, долларовые строки', () => {
    expect(parts(`select 'a''b', "x""y" -- c\nfrom /* a /* b */ c */ t where s = $q$ ; $q$`)).toEqual([
      ['code', 'select '],
      ['string', "'a''b'"],
      ['code', ', '],
      ['quotedIdent', '"x""y"'],
      ['code', ' '],
      ['lineComment', '-- c\n'],
      ['code', 'from '],
      ['blockComment', '/* a /* b */ c */'],
      ['code', ' t where s = '],
      ['dollarString', '$q$ ; $q$'],
    ]);
  });

  it("E'…' с обратной косой: \\' не закрывает строку; префикс E — в коде", () => {
    expect(parts("select E'a\\'b', 1")).toEqual([
      ['code', 'select E'],
      ['string', "'a\\'b'"],
      ['code', ', 1'],
    ]);
  });

  it('$$…$$ и $1: позиционный параметр — код, не долларовая строка', () => {
    expect(parts('select $$x$$, $1')).toEqual([
      ['code', 'select '],
      ['dollarString', '$$x$$'],
      ['code', ', $1'],
    ]);
  });

  it('a$b$c — идентификатор с $, не долларовая строка', () => {
    expect(parts('select a$b$c')).toEqual([['code', 'select a$b$c']]);
  });

  it('незакрытые строка, комментарий, кавычки, $$ — до конца текста', () => {
    expect(parts("select 'abc")).toEqual([['code', 'select '], ['string', "'abc"]]);
    expect(parts('select /* /* */ x')).toEqual([['code', 'select '], ['blockComment', '/* /* */ x']]);
    expect(parts('select "abc')).toEqual([['code', 'select '], ['quotedIdent', '"abc']]);
    expect(parts('select $$abc')).toEqual([['code', 'select '], ['dollarString', '$$abc']]);
    expect(parts('select 1 -- x')).toEqual([['code', 'select 1 '], ['lineComment', '-- x']]);
  });

  it('участки покрывают строку подряд', () => {
    const sql = `a 'b' "c" -- d\n/* e */ $f$g$f$ h`;
    const segs = scanSql(sql);
    expect(segs[0]!.start).toBe(0);
    for (let k = 1; k < segs.length; k++) expect(segs[k]!.start).toBe(segs[k - 1]!.end);
    expect(segs.at(-1)!.end).toBe(sql.length);
  });
});
```

- [ ] **Step 2: убедиться, что тест падает**

Run: `pnpm --filter @carbone-reports/shared exec vitest run src/sql-scan.test.ts`
Expected: FAIL — модуля `./sql-scan` нет.

- [ ] **Step 3: реализация**

`packages/shared/src/sql-scan.ts` — логика пропуска перенесена из `parseSqlParams` без изменений:
```ts
/** Вид участка SQL: код или содержимое, которое разбор пропускает целиком. */
export type SqlSegmentKind =
  | 'code'
  | 'lineComment'
  | 'blockComment'
  | 'string'
  | 'quotedIdent'
  | 'dollarString';

/** Участок [start, end) исходного текста. */
export interface SqlSegment {
  kind: SqlSegmentKind;
  start: number;
  end: number;
}

const IDENT_PART = /[A-Za-z0-9_]/;
const DOLLAR_TAG = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;

/**
 * Делит SQL на код и пропускаемые участки: комментарии `--` и `/* *\/` (с вложенностью), строки
 * `'…'` и `E'…'`, идентификаторы в двойных кавычках, долларовые строки `$tag$…$tag$`. Незакрытый
 * участок тянется до конца текста. Участки идут подряд и покрывают весь текст.
 */
export function scanSql(sql: string): SqlSegment[] {
  const n = sql.length;
  const out: SqlSegment[] = [];
  let codeStart = 0;
  let i = 0;
  const prevIsIdent = (pos: number) => pos > 0 && IDENT_PART.test(sql[pos - 1]!);
  const skip = (kind: SqlSegmentKind, start: number, end: number) => {
    if (codeStart < start) out.push({ kind: 'code', start: codeStart, end: start });
    out.push({ kind, start, end });
    i = end;
    codeStart = end;
  };

  while (i < n) {
    const c = sql[i]!;
    const next = sql[i + 1];

    if (c === '-' && next === '-') {
      const e = sql.indexOf('\n', i);
      skip('lineComment', i, e === -1 ? n : e + 1);
      continue;
    }

    if (c === '/' && next === '*') {
      let depth = 0;
      let j = i;
      while (j < n) {
        if (sql.startsWith('/*', j)) {
          depth++;
          j += 2;
        } else if (sql.startsWith('*/', j)) {
          depth--;
          j += 2;
          if (depth === 0) break;
        } else {
          j++;
        }
      }
      skip('blockComment', i, j);
      continue;
    }

    if (c === "'") {
      const isEscape = i > 0 && /[eE]/.test(sql[i - 1]!) && !prevIsIdent(i - 1);
      let j = i + 1;
      while (j < n) {
        if (isEscape && sql[j] === '\\') {
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      skip('string', i, Math.min(j, n));
      continue;
    }

    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '"') {
          if (sql[j + 1] === '"') {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      skip('quotedIdent', i, Math.min(j, n));
      continue;
    }

    if (c === '$' && !prevIsIdent(i)) {
      const m = DOLLAR_TAG.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        skip('dollarString', i, end === -1 ? n : end + tag.length);
        continue;
      }
    }

    i++;
  }
  if (codeStart < n) out.push({ kind: 'code', start: codeStart, end: n });
  return out;
}
```
`packages/shared/src/index.ts` — рядом с прочими `export * from …`:
```ts
export * from './sql-scan';
```

- [ ] **Step 4: тест сканера проходит**

Run: `pnpm --filter @carbone-reports/shared exec vitest run src/sql-scan.test.ts`
Expected: PASS.

- [ ] **Step 5: `parseSqlParams` поверх `scanSql`**

`apps/api/src/modules/queries/sql-params.ts` — весь файл:
```ts
import { scanSql } from '@carbone-reports/shared';
import { ruText } from '../../lib/errors';

export interface ParsedSql {
  text: string;
  names: string[];
}

/** Ошибка разбора параметров SQL: key — ключ каталога errors, message — тот же текст по-русски. */
export class SqlParamError extends Error {
  constructor(readonly key: string) {
    super(ruText(key));
  }
}

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;

/**
 * Заменяет :name на $n, пропуская строки, идентификаторы в кавычках, комментарии (scanSql) и ::cast.
 * `:name` — параметр, только если перед `:` не идентификатор/цифра (иначе это срез массива a[1:n]).
 */
export function parseSqlParams(sql: string): ParsedSql {
  const names: string[] = [];
  let out = '';
  const prevIsIdent = (pos: number) => pos > 0 && IDENT_PART.test(sql[pos - 1]!);

  for (const seg of scanSql(sql)) {
    if (seg.kind !== 'code') {
      out += sql.slice(seg.start, seg.end);
      continue;
    }
    let i = seg.start;
    while (i < seg.end) {
      const c = sql[i]!;
      const next = sql[i + 1];

      if (c === '$' && !prevIsIdent(i) && next !== undefined && /[0-9]/.test(next)) {
        throw new SqlParamError('sql.positionalParams');
      }

      if (c === ':') {
        if (next === ':') {
          out += '::';
          i += 2;
          continue;
        }
        if (next !== undefined && IDENT_START.test(next) && !prevIsIdent(i)) {
          let j = i + 1;
          while (j < seg.end && IDENT_PART.test(sql[j]!)) j++;
          const name = sql.slice(i + 1, j);
          let idx = names.indexOf(name);
          if (idx === -1) idx = names.push(name) - 1;
          out += `$${idx + 1}`;
          i = j;
          continue;
        }
      }

      out += c;
      i++;
    }
  }

  return { text: out, names };
}
```

- [ ] **Step 6: регрессия**

Run: `pnpm --filter @carbone-reports/api exec vitest run src/modules/queries/sql-params.test.ts src/modules/queries/param-deps.test.ts src/modules/queries/sql-hints.test.ts`
Expected: PASS без правок тестов.
Run: `pnpm --filter @carbone-reports/shared test && pnpm -r typecheck`
Expected: PASS.

- [ ] **Step 7: commit**
```bash
git add packages/shared/src/sql-scan.ts packages/shared/src/sql-scan.test.ts packages/shared/src/index.ts apps/api/src/modules/queries/sql-params.ts
git commit -m "refactor(sql): shared SQL scanner, parseSqlParams on top of it" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QhpYjvmQgUdZAFnqrogAEB"
```

---

### Task 2: `checkReadOnlySql` и список запрещённых функций

**Files:**
- Create: `packages/shared/src/sql-readonly.ts`
- Create: `packages/shared/src/sql-readonly.test.ts`
- Modify: `packages/shared/src/index.ts` (экспорт)

**Interfaces:**
- Consumes: `scanSql` (Task 1).
- Produces:
  ```ts
  export type ReadOnlySqlCheck = { ok: true } | { ok: false; found: string };
  export const FORBIDDEN_SQL_FUNCTIONS: readonly string[]; // точные имена и шаблоны с '*'
  export function checkReadOnlySql(sql: string): ReadOnlySqlCheck;
  ```

Правила (§47.1), по порядку проверки:
1. Лексемы строятся из участков `code`; комментарии пропускаются, строки и долларовые строки дают лексему-литерал, идентификатор в кавычках — лексему-имя (без кавычек, `""` → `"`). Слово — `[A-Za-z_\u0080-￿][A-Za-z0-9_$\u0080-￿]*`. Число начинается с цифры и тянется по символам слова и `.`. `::` — одна лексема. `:имя` (перед `:` не символ слова и не `:`, после — начало слова) — параметр, его имя словом не считается.
2. Пусто → `found: ''`.
3. Первая `;` есть и она не последняя лексема → `found: ';'`.
4. Первая лексема (без завершающей `;`) — не слово `SELECT`/`WITH`/`VALUES`/`TABLE` (без учёта регистра) и не `(` → `found` = её текст (слово — в верхнем регистре).
5. По лексемам слева направо:
   - слово `FOR`, за ним слова `UPDATE` | `NO KEY UPDATE` | `SHARE` | `KEY SHARE` → `found` = `FOR UPDATE` / `FOR NO KEY UPDATE` / `FOR SHARE` / `FOR KEY SHARE`;
   - слово `INSERT`/`UPDATE`/`DELETE`/`MERGE`/`INTO` → `found` = оно в верхнем регистре;
   - слово или имя в кавычках, за которым следует лексема `(`, и его имя в нижнем регистре совпадает с `FORBIDDEN_SQL_FUNCTIONS` → `found` = имя в нижнем регистре. Схема (`pg_catalog.`) отделена лексемой `.`, поэтому проверяется последнее имя перед `(`.

- [ ] **Step 1: табличный тест**

`packages/shared/src/sql-readonly.test.ts`:
```ts
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
      'dblink', 'dblink_exec', 'pg_terminate_backend', 'pg_cancel_backend', 'pg_reload_conf',
      'pg_rotate_logfile', 'pg_promote', 'pg_log_backend_memory_contexts', 'pg_advisory_lock',
      'pg_advisory_xact_lock_shared', 'pg_try_advisory_lock', 'set_config', 'pg_read_file',
      'pg_read_binary_file', 'pg_ls_dir', 'pg_ls_waldir', 'pg_stat_file', 'lo_import', 'lo_export',
      'loread', 'lowrite', 'pg_sleep', 'pg_sleep_until', 'nextval', 'setval', 'pg_notify',
      'txid_current', 'pg_current_xact_id', 'pg_current_xact_id_if_assigned', 'query_to_xml',
      'query_to_xmlschema', 'query_to_xml_and_xmlschema', 'cursor_to_xml', 'table_to_xml',
      'database_to_xml', 'schema_to_xml', 'pg_create_restore_point', 'pg_switch_wal',
      'pg_start_backup', 'pg_backup_start', 'pg_stop_backup', 'pg_backup_stop',
      'pg_create_logical_replication_slot', 'pg_drop_replication_slot',
      'pg_replication_origin_create', 'pg_import_system_collations',
    ]) {
      expect(checkReadOnlySql(`select ${name}(1)`), name).toEqual({ ok: false, found: name });
    }
  });

  it('похожие безопасные имена не задеты', () => {
    for (const name of ['lower', 'local_fn', 'my_pg_sleep_report', 'set_name', 'txid', 'pg_size_pretty'])
      expect(checkReadOnlySql(`select ${name}(1)`), name).toEqual({ ok: true });
  });
});
```

- [ ] **Step 2: тест падает**

Run: `pnpm --filter @carbone-reports/shared exec vitest run src/sql-readonly.test.ts`
Expected: FAIL — модуля нет.

- [ ] **Step 3: реализация**

`packages/shared/src/sql-readonly.ts`:
```ts
import { scanSql } from './sql-scan';

export type ReadOnlySqlCheck = { ok: true } | { ok: false; found: string };

/**
 * Функции, которые запросы отчётов вызывать не могут (§47.1): точные имена и шаблоны,
 * `*` — любое продолжение. Сравнение — без учёта регистра, по имени без схемы.
 */
export const FORBIDDEN_SQL_FUNCTIONS: readonly string[] = [
  // Соединения с другими базами: чтение и запись в обход источника и его транзакции.
  'dblink',
  'dblink_*',
  // Управление сервером и чужими сеансами.
  'pg_terminate_backend',
  'pg_cancel_backend',
  'pg_reload_conf',
  'pg_rotate_logfile',
  'pg_promote',
  'pg_log_backend_memory_contexts',
  // Сессионные блокировки и смена настроек сеанса: переживают запрос, могут снять statement_timeout.
  'pg_advisory_*',
  'pg_try_advisory_*',
  'set_config',
  // Чтение файлов и каталогов сервера БД.
  'pg_read_file',
  'pg_read_binary_file',
  'pg_ls_*',
  'pg_stat_file',
  // Большие объекты: импорт и экспорт файлов, запись объектов в обход прав на таблицы.
  'lo_*',
  'loread',
  'lowrite',
  // Удержание соединения источника.
  'pg_sleep*',
  // Изменение последовательностей и уведомления — запись, которую READ ONLY не всегда останавливает.
  'nextval',
  'setval',
  'pg_notify',
  // Выдача номера транзакции.
  'txid_*',
  'pg_current_xact_id*',
  // Выполнение SQL из строки (обходит эту проверку) и выгрузка целых таблиц, схем и баз.
  'query_to_xml*',
  'query_to_xmlschema',
  'cursor_to_xml*',
  'table_to_xml*',
  'database_to_xml*',
  'schema_to_xml*',
  // Резервное копирование и WAL.
  'pg_create_restore_point',
  'pg_switch_wal',
  'pg_start_backup',
  'pg_backup_start',
  'pg_stop_backup',
  'pg_backup_stop',
  // Репликация.
  'pg_*replication*',
  'pg_replication_origin_*',
  // Изменение системного каталога.
  'pg_import_system_collations',
];

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const FORBIDDEN_RE = new RegExp(
  `^(?:${FORBIDDEN_SQL_FUNCTIONS.map((p) => p.split('*').map(escapeRe).join('.*')).join('|')})$`,
);

const FIRST_WORDS = new Set(['SELECT', 'WITH', 'VALUES', 'TABLE']);
const FORBIDDEN_WORDS = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'INTO']);
const LOCK_CLAUSES = [['UPDATE'], ['NO', 'KEY', 'UPDATE'], ['SHARE'], ['KEY', 'SHARE']];

const WORD_START = /[A-Za-z_\u0080-￿]/;
const WORD_PART = /[A-Za-z0-9_$\u0080-￿]/;

type Tok =
  | { t: 'word'; v: string } // слово без кавычек, v — как в тексте
  | { t: 'name'; v: string } // идентификатор в двойных кавычках, v — без кавычек
  | { t: 'punct'; v: string }
  | { t: 'lit'; v: string } // строка, долларовая строка, число
  | { t: 'param'; v: string };

function tokenize(sql: string): Tok[] {
  const toks: Tok[] = [];
  for (const seg of scanSql(sql)) {
    const raw = sql.slice(seg.start, seg.end);
    if (seg.kind === 'lineComment' || seg.kind === 'blockComment') continue;
    if (seg.kind === 'string' || seg.kind === 'dollarString') {
      toks.push({ t: 'lit', v: raw });
      continue;
    }
    if (seg.kind === 'quotedIdent') {
      const closed = raw.length >= 2 && raw.endsWith('"');
      toks.push({ t: 'name', v: raw.slice(1, closed ? -1 : undefined).replaceAll('""', '"') });
      continue;
    }
    let i = seg.start;
    while (i < seg.end) {
      const c = sql[i]!;
      if (/\s/.test(c)) {
        i++;
        continue;
      }
      if (WORD_START.test(c)) {
        let j = i + 1;
        while (j < seg.end && WORD_PART.test(sql[j]!)) j++;
        toks.push({ t: 'word', v: sql.slice(i, j) });
        i = j;
        continue;
      }
      if (/[0-9]/.test(c)) {
        let j = i + 1;
        while (j < seg.end && (WORD_PART.test(sql[j]!) || sql[j] === '.')) j++;
        toks.push({ t: 'lit', v: sql.slice(i, j) });
        i = j;
        continue;
      }
      if (c === ':') {
        const next = sql[i + 1];
        if (next === ':') {
          toks.push({ t: 'punct', v: '::' });
          i += 2;
          continue;
        }
        const prev = i > 0 ? sql[i - 1]! : '';
        if (next !== undefined && i + 1 < seg.end && WORD_START.test(next) && !WORD_PART.test(prev)) {
          let j = i + 2;
          while (j < seg.end && WORD_PART.test(sql[j]!)) j++;
          toks.push({ t: 'param', v: sql.slice(i, j) });
          i = j;
          continue;
        }
      }
      toks.push({ t: 'punct', v: c });
      i++;
    }
  }
  return toks;
}

const isWord = (x: Tok | undefined, w: string) => x?.t === 'word' && x.v.toUpperCase() === w;
const fail = (found: string): ReadOnlySqlCheck => ({ ok: false, found });

/**
 * Запрос только читает данные (§47.1): одна команда, начинается с SELECT/WITH/VALUES/TABLE/`(`,
 * без изменяющих слов, блокировок строк и функций из FORBIDDEN_SQL_FUNCTIONS. Содержимое строк,
 * комментариев и идентификаторов в кавычках словами не считается.
 */
export function checkReadOnlySql(sql: string): ReadOnlySqlCheck {
  const toks = tokenize(sql);
  if (toks.length === 0) return fail('');

  const semi = toks.findIndex((x) => x.t === 'punct' && x.v === ';');
  if (semi !== -1 && semi !== toks.length - 1) return fail(';');
  const body = semi === -1 ? toks : toks.slice(0, -1);

  const first = body[0];
  if (!first) return fail(';');
  const firstOk =
    (first.t === 'punct' && first.v === '(') ||
    (first.t === 'word' && FIRST_WORDS.has(first.v.toUpperCase()));
  if (!firstOk)
    return fail(
      first.t === 'word' ? first.v.toUpperCase() : first.t === 'name' ? `"${first.v}"` : first.v,
    );

  for (let k = 0; k < body.length; k++) {
    const x = body[k]!;
    if (x.t === 'word') {
      const w = x.v.toUpperCase();
      if (w === 'FOR') {
        const lock = LOCK_CLAUSES.find((words) => words.every((lw, n) => isWord(body[k + 1 + n], lw)));
        if (lock) return fail(['FOR', ...lock].join(' '));
      }
      if (FORBIDDEN_WORDS.has(w)) return fail(w);
    }
    if ((x.t === 'word' || x.t === 'name') && body[k + 1]?.t === 'punct' && body[k + 1]!.v === '(') {
      const name = x.v.toLowerCase();
      if (FORBIDDEN_RE.test(name)) return fail(name);
    }
  }
  return { ok: true };
}
```
Замечание: строка `if (!first) return fail(';');` срабатывает для текста из одной `;` — первая и единственная лексема `;`, после её отбрасывания команды нет. Тест добавь в таблицу «запрещено»: `[';', ';']`.

`packages/shared/src/index.ts`:
```ts
export * from './sql-readonly';
```

- [ ] **Step 4: тест проходит**

Run: `pnpm --filter @carbone-reports/shared exec vitest run src/sql-readonly.test.ts`
Expected: PASS. Если какой-то случай таблицы расходится с правилами §47.1, прав §47.1: исправляй реализацию, а не ожидание. Ожидание меняй, только если ошибочно оно само, и опиши это в отчёте.

- [ ] **Step 5: прогон пакета, typecheck, commit**

Run: `pnpm --filter @carbone-reports/shared test && pnpm -r typecheck && pnpm lint`
```bash
git add packages/shared/src/sql-readonly.ts packages/shared/src/sql-readonly.test.ts packages/shared/src/index.ts
git commit -m "feat(sql): checkReadOnlySql — read-only rule and forbidden functions (§47.1)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QhpYjvmQgUdZAFnqrogAEB"
```

---

### Task 3: проверка в executor до соединения; второй рубеж в тестах

**Files:**
- Modify: `apps/api/src/modules/queries/executor.ts`
- Modify: `packages/shared/src/i18n/{ru,en,es,pt-BR,fr,de,zh-CN}/errors.json` (ключ `sql.notReadOnly`)
- Modify: `apps/api/src/modules/queries/executor.test.ts` (модульные тесты с поддельным пулом)
- Modify: `apps/api/test/executor.int.test.ts`
- Modify: `apps/api/test/reports.int.test.ts`
- Create: `apps/api/test/sql-readonly.int.test.ts` (часть «выполнение»; задача 4 дополнит файл)

**Interfaces:**
- Consumes: `checkReadOnlySql` из `@carbone-reports/shared` (Task 2).
- Produces: `runQueries`, `previewQuery`, `loadParamOptions` становятся `async`, сигнатуры прежние. Нарушение → `AppError('SQL_ERROR', 400, { key: 'sql.notReadOnly', params: { what, found } })` до `pool.connect()`. Проверяются все SQL набора до соединения.

- [ ] **Step 1: тексты `errors` → `sql.notReadOnly`** (в объект `sql`, после `readOnly`)

| locale | текст |
|---|---|
| ru | `{{what}}: разрешены только запросы на чтение (SELECT); найдено: {{found}}` |
| en | `{{what}}: only read queries (SELECT) are allowed; found: {{found}}` |
| de | `{{what}}: nur lesende Abfragen (SELECT) sind erlaubt; gefunden: {{found}}` |
| fr | `{{what}} : seules les requêtes en lecture (SELECT) sont autorisées ; trouvé : {{found}}` — пробел перед `:` и `;` тот же символ, что перед `:` в соседнем `sql.readOnly` этого файла |
| es | `{{what}}: solo se permiten consultas de lectura (SELECT); encontrado: {{found}}` |
| pt-BR | `{{what}}: apenas consultas de leitura (SELECT) são permitidas; encontrado: {{found}}` |
| zh-CN | `{{what}}：仅允许只读查询（SELECT）；发现：{{found}}` |

- [ ] **Step 2: модульный тест — отказ до соединения**

Дописать в `apps/api/src/modules/queries/executor.test.ts`:
```ts
import type pg from 'pg';
import { vi } from 'vitest';
import { AppError } from '../../lib/errors';
import { loadParamOptions, previewQuery, runQueries } from './executor';

describe('только чтение: отказ до соединения (§47.2)', () => {
  const limits = { timeoutMs: 1000, maxRows: 5 };
  const fakePool = () => {
    const connect = vi.fn(() => Promise.reject(new Error('не должно подключаться')));
    return { pool: { connect } as unknown as pg.Pool, connect };
  };

  it('runQueries: второй запрос нарушает правило — ни одного соединения', async () => {
    const { pool, connect } = fakePool();
    const e = await runQueries(
      pool,
      'src',
      [
        { key: 'ok', mode: 'list', sql: 'select 1' },
        { key: 'w', mode: 'list', sql: 'drop table t' },
      ],
      {},
      limits,
    ).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AppError);
    expect([(e as AppError).code, (e as AppError).status, (e as AppError).message]).toEqual([
      'SQL_ERROR',
      400,
      'запрос "w": разрешены только запросы на чтение (SELECT); найдено: DROP',
    ]);
    expect(connect).not.toHaveBeenCalled();
  });

  it('previewQuery', async () => {
    const { pool, connect } = fakePool();
    const e = await previewQuery(pool, 'src', 'select pg_sleep(1)', {}, { ...limits, previewRows: 3 }).catch(
      (x: unknown) => x,
    );
    expect((e as AppError).message).toBe(
      'запрос "preview": разрешены только запросы на чтение (SELECT); найдено: pg_sleep',
    );
    expect(connect).not.toHaveBeenCalled();
  });

  it('loadParamOptions', async () => {
    const { pool, connect } = fakePool();
    const def = {
      name: 'p',
      label: 'Счёт',
      type: 'query' as const,
      required: false,
      defaultValue: null,
      options: null,
      sql: "select nextval('s') as value",
      multiple: false,
    };
    const e = await loadParamOptions(pool, 'src', [{ def, params: {} }], limits).catch(
      (x: unknown) => x,
    );
    expect((e as AppError).message).toBe(
      'параметр "Счёт": разрешены только запросы на чтение (SELECT); найдено: nextval',
    );
    expect(connect).not.toHaveBeenCalled();
  });
});
```
Импорты объедини с уже имеющимися в начале файла (`describe, expect, it` из vitest, `rowsToOptions`).

Run: `pnpm --filter @carbone-reports/api exec vitest run src/modules/queries/executor.test.ts` → FAIL (подключение вызывается / ключа нет).

- [ ] **Step 3: реализация в `executor.ts`**

Импорт: добавить `checkReadOnlySql` в импорт из `@carbone-reports/shared`. После `queryWhat`:
```ts
/** Статическая проверка «только чтение» (§47.1) — до соединения с источником. */
function assertReadOnly(what: Msg, sql: string): void {
  const r = checkReadOnlySql(sql);
  if (!r.ok)
    throw new AppError('SQL_ERROR', 400, {
      key: 'sql.notReadOnly',
      params: { what, found: r.found },
    });
}
```
`runQueries` → `export async function runQueries(…): Promise<QueryResult[]>`, первая строка тела:
```ts
  for (const q of queries) assertReadOnly(queryWhat(q.key), q.sql);
```
затем прежнее `return withReadOnly(…)`. `previewQuery` → `async`, первая строка `assertReadOnly(queryWhat('preview'), sql);`. `loadParamOptions` → `async`, первая строка:
```ts
  for (const { def } of items) assertReadOnly(text('sql.param', { label: def.label }), def.sql!);
```

Run: модульный тест из Step 2 → PASS.

- [ ] **Step 4: `executor.int.test.ts` — опасные вызовы через функции источника**

В сид `createSourceDatabase` в `beforeAll` (после `create table big …`) добавить:
```sql
create function sleep_for(s float8) returns void language sql as 'select pg_sleep(s)';
create function write_company() returns setof company language sql as $$insert into company values ('x') returning *$$;
create function evil_path() returns text language sql as $$select set_config('search_path', 'evil', false)$$;
create function lock42() returns void language sql as 'select pg_advisory_lock(42)';
create function no_timeout() returns text language sql as $$select set_config('statement_timeout', '0', true)$$;
```
Правки:
- «запрет записи: INSERT падает с понятной ошибкой»: SQL → `select * from write_company()`. Ожидания прежние (`SQL_ERROR`, `/^запрос "w": .*только на чтение/`, в `company` одна строка). Рядом новый тест «INSERT в тексте — отказ до выполнения»: `runQueries(pool, 'src', [{ key: 'w', mode: 'list', sql: "insert into company values ('x') returning *" }], {}, limits)` → `[code, message]` = `['SQL_ERROR', 'запрос "w": разрешены только запросы на чтение (SELECT); найдено: INSERT']`.
- Каждый `pg_sleep(…)` в SQL, передаваемом в `runQueries`/`previewQuery`, заменить на `sleep_for(…)` с тем же аргументом, включая `select g, pg_sleep(case …)` → `select g, sleep_for(case …)`. Строку для `pg_terminate_backend` в тесте обрыва (это прямой запрос администратора, не через executor) переписать на `query like '%sleep_for(5)%'`.
- `it.each(['commit', 'rollback', 'end', 'abort', 'commit and chain', 'rollback and chain'])`: заголовок `'%s как первый запрос → отказ до соединения, запись не проходит'`, ожидаемое сообщение `` `запрос "c": разрешены только запросы на чтение (SELECT); найдено: ${sql.split(' ')[0]!.toUpperCase()}` ``, проверка `companyCount()` остаётся.
- «commit + set_config не протекает в пул» → заголовок «set_config(search_path) в функции не протекает в пул»: первый вызов `runQueries(onePool, 'src', [{ key: 's', mode: 'single', sql: 'select evil_path()' }], {}, limits)` — без `err(...)`, он проходит. Дальнейшая проверка `current_setting('search_path')` не `evil` — прежняя.
- «advisory-лок не переживает запрос»: SQL → `select lock42()`.
- «prepared statement не переживает запрос»: оставить как есть, над тестом комментарий `// С 2.16.0 PREPARE/EXECUTE отклоняются статически (§47.1).`
- «previewQuery: commit → SQL_ERROR»: ожидаемое сообщение `'запрос "preview": разрешены только запросы на чтение (SELECT); найдено: COMMIT'`.
- «с активным сроком set_config(statement_timeout) в SQL → SQL_ERROR…»: SQL → `select no_timeout()`, ожидания прежние (guard).

- [ ] **Step 5: `reports.int.test.ts`**

В сид каждого `createSourceDatabase`, чьим источником пользуются тесты с `pg_sleep`, добавить `create function sleep_for(s float8) returns void language sql as 'select pg_sleep(s)';`. Заменить в SQL запросов и параметров `pg_sleep(x)` → `sleep_for(x)` (`pg_sleep(2)::text` → `sleep_for(2)::text`). В запросе к `pg_stat_activity` — `query like '%sleep_for%'`. Заголовки тестов с «pg_sleep(2)» поменять на «sleep_for(2)».

- [ ] **Step 6: интеграционный тест «выполнение сохранённого до 2.16.0»**

`apps/api/test/sql-readonly.int.test.ts`:
```ts
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { templateParams, templateQueries } from '../src/db/schema';
import { createSourceDatabase, createTestApp, loginAs, openTemplate, type TestApp } from './helpers';

let t: TestApp;
let admin: string;
let liveDs: string;
let deadDs: string;

async function createDs(payload: object): Promise<string> {
  const r = await t.app.inject({
    method: 'POST',
    url: '/api/datasources',
    headers: { cookie: admin },
    payload,
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json().id as string;
}

async function createTpl(datasourceId: string): Promise<string> {
  const r = await t.app.inject({
    method: 'POST',
    url: '/api/templates',
    headers: { cookie: admin },
    payload: { name: `ro ${Math.random().toString(16).slice(2, 8)}`, datasourceId, blank: 'docx' },
  });
  expect(r.statusCode).toBe(201);
  const id = r.json().id as string;
  await openTemplate(t, id);
  return id;
}

/** Запрос, записанный в БД в обход проверки (как сохранённый до 2.16.0). */
async function storeQuery(templateId: string, key: string, sql: string) {
  await t.deps.db.insert(templateQueries).values({ templateId, key, sql, mode: 'list', sortOrder: 0 });
}

beforeAll(async () => {
  t = await createTestApp();
  admin = (await loginAs(t, 'admin')).cookie;
  const src = await createSourceDatabase('create table orders(id int, total numeric);');
  liveDs = await createDs({ name: 'live', ...src, sslMode: 'disable' });
  // Порт 1 закрыт: попытка соединения дала бы 502 DATASOURCE_UNAVAILABLE.
  deadDs = await createDs({
    name: 'dead',
    host: '127.0.0.1',
    port: 1,
    database: 'x',
    username: 'x',
    password: 'x',
    sslMode: 'disable',
  });
});
afterAll(() => t.close());

describe('выполнение запроса, сохранённого до 2.16.0 (§47.2)', () => {
  it('формирование: 400 SQL_ERROR без подключения к источнику', async () => {
    const id = await createTpl(deadDs);
    await storeQuery(id, 'bad', 'delete from orders');
    const r = await t.app.inject({
      method: 'POST',
      url: `/api/reports/${id}/render`,
      headers: { cookie: admin },
      payload: { params: {} },
    });
    expect(r.statusCode, r.body).toBe(400);
    expect(r.json().error).toMatchObject({
      code: 'SQL_ERROR',
      message: 'запрос "bad": разрешены только запросы на чтение (SELECT); найдено: DELETE',
    });
  });

  it('контроль: допустимый запрос к тому же источнику — 502 (соединение пробовалось)', async () => {
    const id = await createTpl(deadDs);
    await storeQuery(id, 'ok', 'select 1');
    const r = await t.app.inject({
      method: 'POST',
      url: `/api/reports/${id}/render`,
      headers: { cookie: admin },
      payload: { params: {} },
    });
    expect([r.statusCode, r.json().error.code]).toEqual([502, 'DATASOURCE_UNAVAILABLE']);
  });

  it('предпросмотр данных и «Выполнить» в редакторе: 400 SQL_ERROR, текст на en', async () => {
    const id = await createTpl(deadDs);
    await storeQuery(id, 'bad', 'select * from orders for update');
    const preview = await t.app.inject({
      method: 'POST',
      url: `/api/templates/${id}/preview`,
      headers: { cookie: admin, 'x-locale': 'en' },
      payload: { params: {}, mode: 'data' },
    });
    expect(preview.statusCode, preview.body).toBe(400);
    expect(preview.json().error.code).toBe('SQL_ERROR');
    expect(preview.json().error.message).toContain('only read queries (SELECT) are allowed; found: FOR UPDATE');
    const run = await t.app.inject({
      method: 'POST',
      url: `/api/templates/${id}/queries/run`,
      headers: { cookie: admin },
      payload: { sql: 'drop table orders', params: {} },
    });
    expect([run.statusCode, run.json().error.code]).toEqual([400, 'SQL_ERROR']);
    expect(run.json().error.message).toContain('найдено: DROP');
  });

  it('варианты параметра: 400 SQL_ERROR', async () => {
    const id = await createTpl(deadDs);
    await t.deps.db.insert(templateParams).values({
      templateId: id,
      name: 'p',
      label: 'Счёт',
      type: 'query',
      required: false,
      defaultValue: null,
      options: null,
      sql: 'select pg_sleep(1) as value',
      multiple: false,
      sortOrder: 0,
    });
    const r = await t.app.inject({
      method: 'POST',
      url: `/api/templates/${id}/params/p/options`,
      headers: { cookie: admin },
      payload: { params: {} },
    });
    expect(r.statusCode, r.body).toBe(400);
    expect(r.json().error).toMatchObject({
      code: 'SQL_ERROR',
      message: 'параметр "Счёт": разрешены только запросы на чтение (SELECT); найдено: pg_sleep',
    });
  });

  it('допустимый запрос к живому источнику выполняется', async () => {
    const id = await createTpl(liveDs);
    await storeQuery(id, 'ok', 'select count(*)::int as n from orders');
    const r = await t.app.inject({
      method: 'POST',
      url: `/api/templates/${id}/preview`,
      headers: { cookie: admin },
      payload: { params: {}, mode: 'data' },
    });
    expect(r.statusCode, r.body).toBe(200);
  });
});
```
Если поля строк `templateQueries`/`templateParams` в `apps/api/src/db/schema.ts` называются иначе, следуй схеме. Ответ формирования может прийти через другой маршрут или с другим `payload`; тогда возьми форму из `reports.int.test.ts` и опиши это в отчёте. `eq` нужен задаче 4; если линтер ругается на неиспользуемый импорт, добавь его в задаче 4.

- [ ] **Step 7: прогон и commit**

Run (последовательно):
`pnpm --filter @carbone-reports/api exec vitest run src/modules/queries`
`pnpm --filter @carbone-reports/api exec vitest run --config vitest.int.config.ts test/executor.int.test.ts test/reports.int.test.ts test/param-options.int.test.ts test/sql-readonly.int.test.ts`
`pnpm i18n:check && pnpm -r typecheck && pnpm lint`
Expected: PASS.
```bash
git add apps/api/src/modules/queries/executor.ts apps/api/src/modules/queries/executor.test.ts apps/api/test/executor.int.test.ts apps/api/test/reports.int.test.ts apps/api/test/sql-readonly.int.test.ts packages/shared/src/i18n
git commit -m "feat(sql): reject non-read-only SQL before connecting to the source (§47.2)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QhpYjvmQgUdZAFnqrogAEB"
```

---

### Task 4: проверка при сохранении, импорте и выгрузке

**Files:**
- Modify: `packages/shared/src/index.ts` (`TemplateQuery.sql`, `refineTemplateParam`)
- Modify: `packages/shared/src/i18n/{ru,en,es,pt-BR,fr,de,zh-CN}/validation.json` (ключ `sql.readOnlyOnly`)
- Modify: `packages/shared/src/index.test.ts` (схемы)
- Modify: `apps/api/test/sql-readonly.int.test.ts` (сохранение, демо, выгрузка)
- Modify: `apps/api/test/template-transfer.int.test.ts` (импорт)
- Modify: `apps/web/src/pages/admin/template-editor/DataTab.test.tsx`, `ParamsTab.test.tsx`

**Interfaces:**
- Consumes: `checkReadOnlySql` (Task 2).
- Produces: issue zod `{ code: 'custom', path: ['sql'] (относительно запроса/параметра), message: 'v:sql.readOnlyOnly', params: { found } }`. В ответе `400 VALIDATION` это `details: [{ path: '/<i>/sql', message: <текст на языке запроса> }]`.

- [ ] **Step 1: тексты `validation` → `sql.readOnlyOnly`** (новый объект `"sql"` на верхнем уровне файла, рядом с `"query"`)

| locale | текст |
|---|---|
| ru | `Разрешены только запросы на чтение (SELECT); найдено: {{found}}. Если это имя колонки, возьмите его в двойные кавычки` |
| en | `Only read queries (SELECT) are allowed; found: {{found}}. If this is a column name, put it in double quotes` |
| de | `Nur lesende Abfragen (SELECT) sind erlaubt; gefunden: {{found}}. Wenn das ein Spaltenname ist, setzen Sie ihn in doppelte Anführungszeichen` |
| fr | `Seules les requêtes en lecture (SELECT) sont autorisées ; trouvé : {{found}}. S’il s’agit d’un nom de colonne, mettez-le entre guillemets doubles` — пробелы перед `;` и `:` те же, что в `fr/errors.json` → `sql.readOnly` |
| es | `Solo se permiten consultas de lectura (SELECT); encontrado: {{found}}. Si es un nombre de columna, escríbalo entre comillas dobles` |
| pt-BR | `Apenas consultas de leitura (SELECT) são permitidas; encontrado: {{found}}. Se for um nome de coluna, coloque-o entre aspas duplas` |
| zh-CN | `仅允许只读查询（SELECT）；发现：{{found}}。如果这是列名，请用双引号括起来` |

- [ ] **Step 2: тест схем (падает)**

В `packages/shared/src/index.test.ts`:
```ts
describe('только чтение в схемах (§47.2)', () => {
  const issueOf = (r: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string; params?: unknown }[] } }) =>
    r.error?.issues.map((i) => ({ path: i.path, message: i.message, params: i.params }));

  it('TemplateQuery: изменяющий SQL — issue у sql с found', () => {
    const r = TemplateQuery.safeParse({ key: 'q', sql: 'update t set a = 1', mode: 'list' });
    expect(issueOf(r)).toEqual([
      { path: ['sql'], message: 'v:sql.readOnlyOnly', params: { found: 'UPDATE' } },
    ]);
  });

  it('TemplateQuery: пустой SQL — только прежняя ошибка min(1), без второй', () => {
    const r = TemplateQuery.safeParse({ key: 'q', sql: '   ', mode: 'list' });
    expect(r.success).toBe(false);
    expect(r.error!.issues.every((i) => i.message !== 'v:sql.readOnlyOnly')).toBe(true);
  });

  it('TemplateParam query: запрещённая функция — issue у sql', () => {
    const r = TemplateParam.safeParse({
      name: 'p', label: 'P', type: 'query', required: false, defaultValue: null,
      options: null, sql: "select nextval('s') as value", multiple: false,
    });
    expect(issueOf(r)).toEqual([
      { path: ['sql'], message: 'v:sql.readOnlyOnly', params: { found: 'nextval' } },
    ]);
  });

  it('TemplateParam query: пустой SQL — только sqlRequired', () => {
    const r = TemplateParam.safeParse({
      name: 'p', label: 'P', type: 'query', required: false, defaultValue: null,
      options: null, sql: ' ', multiple: false,
    });
    expect(r.error!.issues.map((i) => i.message)).toEqual(['v:param.sqlRequired']);
  });

  it('TransferQuery и TransferParam наследуют правило', () => {
    expect(
      TransferQuery.safeParse({ key: 'q', sql: 'delete from t', mode: 'list', sortOrder: 0 }).success,
    ).toBe(false);
    expect(
      TransferParam.safeParse({
        name: 'p', label: 'P', type: 'query', required: false, defaultValue: null,
        options: null, sql: 'select pg_sleep(1)', multiple: false, sortOrder: 0,
      }).success,
    ).toBe(false);
  });
});
```
`TransferQuery`/`TransferParam` импортировать из `./template-transfer`, остальное — из `./index` (как уже импортирует файл). Run: `pnpm --filter @carbone-reports/shared exec vitest run src/index.test.ts` → FAIL.

- [ ] **Step 3: реализация в `packages/shared/src/index.ts`**

Импорт: `import { checkReadOnlySql } from './sql-readonly';`. Перед `TemplateParamFields`:
```ts
/** Issue «только чтение» (§47.1) у поля SQL; пустой SQL отклоняют свои правила (min(1), sqlRequired). */
function readOnlyIssue(sql: string | null | undefined): { message: string; params: { found: string } } | null {
  if (!sql || !sql.trim()) return null;
  const r = checkReadOnlySql(sql);
  return r.ok ? null : { message: 'v:sql.readOnlyOnly', params: { found: r.found } };
}
```
`refineTemplateParam`: помощник `issue` получает третий необязательный аргумент:
```ts
  const issue = (path: string, message: string, params?: Record<string, string>) =>
    ctx.addIssue({ code: 'custom', path: [path], message, params });
```
и в ветке `if (p.type === 'query') {` после проверки `sqlRequired`:
```ts
    const ro = readOnlyIssue(p.sql);
    if (ro) issue('sql', ro.message, ro.params);
```
`TemplateQuery.sql`:
```ts
  sql: z
    .string()
    .trim()
    .min(1)
    .superRefine((sql, ctx) => {
      const ro = readOnlyIssue(sql);
      if (ro) ctx.addIssue({ code: 'custom', message: ro.message, params: ro.params });
    }),
```
Run: тест Step 2 → PASS. Затем весь пакет: `pnpm --filter @carbone-reports/shared test`.

- [ ] **Step 4: интеграционные тесты сохранения, демо и выгрузки**

Дописать в `apps/api/test/sql-readonly.int.test.ts`:
```ts
import { DEMO_PARAMS, DEMO_QUERIES } from '../../../demo/template';

const put = (id: string, what: 'queries' | 'params', payload: unknown, locale?: string) =>
  t.app.inject({
    method: 'PUT',
    url: `/api/templates/${id}/${what}`,
    headers: { cookie: admin, ...(locale ? { 'x-locale': locale } : {}) },
    payload,
  });

describe('сохранение (§47.2)', () => {
  it('запрос шаблона: 400 VALIDATION у поля sql, ru и en', async () => {
    const id = await createTpl(liveDs);
    const body = [
      { key: 'ok', sql: 'select 1', mode: 'list' },
      { key: 'bad', sql: 'update orders set total = 0', mode: 'list' },
    ];
    const ru = await put(id, 'queries', body);
    expect(ru.statusCode).toBe(400);
    expect(ru.json().error.code).toBe('VALIDATION');
    expect(ru.json().error.details).toEqual([
      {
        path: '/1/sql',
        message:
          'Разрешены только запросы на чтение (SELECT); найдено: UPDATE. Если это имя колонки, возьмите его в двойные кавычки',
      },
    ]);
    const en = await put(id, 'queries', body, 'en');
    expect(en.json().error.details[0].message).toBe(
      'Only read queries (SELECT) are allowed; found: UPDATE. If this is a column name, put it in double quotes',
    );
    const [stored] = await t.deps.db
      .select()
      .from(templateQueries)
      .where(eq(templateQueries.templateId, id));
    expect(stored).toBeUndefined();
  });

  it('запрос списка значений параметра: 400 VALIDATION у /0/sql', async () => {
    const id = await createTpl(liveDs);
    const r = await put(id, 'params', [
      {
        name: 'p', label: 'P', type: 'query', required: false, defaultValue: null,
        options: null, sql: 'select id as value from orders for share', multiple: false,
      },
    ]);
    expect(r.statusCode).toBe(400);
    expect(r.json().error.details).toEqual([
      {
        path: '/0/sql',
        message:
          'Разрешены только запросы на чтение (SELECT); найдено: FOR SHARE. Если это имя колонки, возьмите его в двойные кавычки',
      },
    ]);
  });

  it('демо-шаблон «Счёт (демо)» сохраняется', async () => {
    const id = await createTpl(liveDs);
    expect((await put(id, 'queries', DEMO_QUERIES)).statusCode).toBe(200);
    expect((await put(id, 'params', DEMO_PARAMS)).statusCode).toBe(200);
  });
});

describe('выгрузка шаблона с запросом, сохранённым до 2.16.0', () => {
  it('400 с путём queries.0.sql, а не 500', async () => {
    const id = await createTpl(liveDs);
    await storeQuery(id, 'bad', 'delete from orders');
    const r = await t.app.inject({
      method: 'POST',
      url: '/api/templates/export',
      headers: { cookie: admin },
      payload: { ids: [id] },
    });
    expect(r.statusCode, r.body).toBe(400);
    expect(r.json().error.message).toContain('queries.0.sql');
    expect(r.json().error.message).toContain('DELETE');
  });
});
```
Маршрут и тело выгрузки возьми из `exportZip` в `apps/api/test/template-transfer.int.test.ts`, если они отличаются от `POST /api/templates/export` `{ ids }`.

- [ ] **Step 5: импорт — `IMPORT_INVALID`**

В `apps/api/test/template-transfer.int.test.ts`, в том же `describe`, сразу после теста «подменённый файл шаблона — 400 IMPORT_INVALID, без записи» (там уже есть `zip`, `b`, `adminB`, `dsB`, `preview`, `apply`, `dbTemplateIds`):
```ts
  it.each([
    ['запрос', (m: any) => m.templates[0].queries.push({ key: 'ro_bad', sql: 'delete from t', mode: 'list', sortOrder: 99 }), 'DELETE'],
    ['параметр', (m: any) => m.templates[0].params.push({
      name: 'ro_bad', label: 'R', type: 'query', required: false, defaultValue: null,
      options: null, sql: 'select pg_sleep(1) as value', multiple: false, sortOrder: 99,
    }), 'pg_sleep'],
  ])('%s, нарушающий «только чтение», — 400 IMPORT_INVALID, без записи (§47.2)', async (_w, mutate, found) => {
    const z = await JSZip.loadAsync(zip);
    const m = JSON.parse(await z.file('manifest.json')!.async('string'));
    mutate(m);
    z.file('manifest.json', JSON.stringify(m));
    const bad = await z.generateAsync({ type: 'nodebuffer' });
    const beforeIds = await dbTemplateIds(b);
    for (const r of [
      await preview(b, adminB, bad),
      await apply(b, adminB, bad, [{ index: 0, action: 'copy', datasourceId: dsB }]),
    ]) {
      expect(r.statusCode).toBe(400);
      expect(r.json().error.code).toBe('IMPORT_INVALID');
      expect(JSON.stringify(r.json())).toContain(found);
    }
    expect(await dbTemplateIds(b)).toEqual(beforeIds);
  });
```
Если в файле `any` запрещён линтером, опиши мутацию через `Record<string, any>` с `// eslint-disable-next-line` или через тип манифеста `TransferManifest`, как принято в файле.

- [ ] **Step 6: веб — сообщение у поля SQL**

`DataTab.test.tsx`, рядом с «ошибка у невыбранного запроса видна в списке и под формой»:
```ts
  it('ошибка «только чтение» показывается под SQL выбранного запроса', async () => {
    const message =
      'Разрешены только запросы на чтение (SELECT); найдено: UPDATE. Если это имя колонки, возьмите его в двойные кавычки';
    mockApi([
      {
        method: 'PUT',
        path: '/api/templates/t1/queries',
        handler: () => validation([{ path: '/0/sql', message }]),
      },
    ]);
    renderWithProviders(<DataTab {...props} />);
    await userEvent.type(await screen.findByLabelText('SQL'), ' ');
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить запросы' }));
    expect(await screen.findByText(message)).toBeInTheDocument();
  });
```
`ParamsTab.test.tsx`, рядом с «ошибка вложенного пути…»:
```ts
  it('ошибка «только чтение» показывается у SQL параметра', async () => {
    const message =
      'Разрешены только запросы на чтение (SELECT); найдено: nextval. Если это имя колонки, возьмите его в двойные кавычки';
    mockApi([
      {
        method: 'PUT',
        path: '/api/templates/t1/params',
        handler: () => validation([{ path: '/0/sql', message }]),
      },
    ]);
    renderWithProviders(<ParamsTab template={t} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Сохранить параметры' }));
    expect(await screen.findByText(message)).toBeInTheDocument();
  });
```
В фикстуре `ParamsTab.test.tsx` параметр 1 может не иметь типа `query`, и тогда поле SQL у него не показано. В этом случае возьми индекс параметра типа `query` из фикстуры `t`; если такого нет — добавь его в фикстуру, не ломая другие тесты. Ожидай, что сообщение — элемент `data-testid="field-error"`, как в соседнем тесте. Если у DataTab в первом тесте сообщение выбранного запроса не помечено так, проверяй только наличие текста.

- [ ] **Step 7: прогон и commit**

Run (последовательно):
`pnpm --filter @carbone-reports/shared test`
`pnpm --filter @carbone-reports/web exec vitest run src/pages/admin/template-editor/DataTab.test.tsx src/pages/admin/template-editor/ParamsTab.test.tsx`
`pnpm --filter @carbone-reports/api exec vitest run --config vitest.int.config.ts test/sql-readonly.int.test.ts test/template-transfer.int.test.ts test/templates.int.test.ts test/param-options.int.test.ts`
`pnpm i18n:check && pnpm -r typecheck && pnpm lint`
Expected: PASS.
```bash
git add packages/shared/src/index.ts packages/shared/src/index.test.ts packages/shared/src/i18n apps/api/test/sql-readonly.int.test.ts apps/api/test/template-transfer.int.test.ts apps/web/src/pages/admin/template-editor/DataTab.test.tsx apps/web/src/pages/admin/template-editor/ParamsTab.test.tsx
git commit -m "feat(sql): read-only rule on save, import and export (§47.2)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QhpYjvmQgUdZAFnqrogAEB"
```

---

### Task 5: README, CHANGELOG, полный прогон

**Files:**
- Modify: `README.md` (раздел «Безопасность источников данных», ~строка 660)
- Modify: `CHANGELOG.md`

- [ ] **Step 1: README** — раздел «Безопасность источников данных», первый абзац заменить на:

```markdown
Запросы шаблона и запросы списков значений параметров могут только читать данные. При сохранении,
загрузке шаблонов из архива и перед выполнением запрос проверяется:

- одна команда (`;` — только в конце), начинается с `SELECT`, `WITH`, `VALUES`, `TABLE` или `(`;
- нет `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `INTO` и блокировок `FOR UPDATE`, `FOR NO KEY UPDATE`,
  `FOR SHARE`, `FOR KEY SHARE` — вне строк, комментариев и имён в двойных кавычках;
- нет вызовов опасных функций: `dblink*`, `pg_sleep*`, `pg_advisory_*`, `set_config`, `nextval`,
  `setval`, `lo_*`, `pg_read_file`, `pg_ls_*`, `query_to_xml*`, `pg_terminate_backend` и других
  (полный список — `FORBIDDEN_SQL_FUNCTIONS` в `packages/shared/src/sql-readonly.ts`).

Колонку с именем вроде `update` или `into` возьмите в двойные кавычки: `select "update" from t`.

Проверка не заменяет права в БД. Подключайте источники под отдельным пользователем PostgreSQL только
с правом `SELECT`:

```sql
create role reports_reader login password '…';
grant connect on database shop to reports_reader;
grant usage on schema public to reports_reader;
grant select on all tables in schema public to reports_reader;
alter default privileges in schema public grant select on tables to reports_reader;
```

Запросы, кроме того, выполняются в `READ ONLY`-транзакции с `statement_timeout`.
```
Абзацы про SSL ниже — без изменений.

- [ ] **Step 2: CHANGELOG** — над `## [2.15.0]`:

```markdown
## [2.16.0] — <дата коммита, ГГГГ-ММ-ДД>

### Добавлено

- Запросы шаблона и запросы списков значений параметров могут только читать данные. Запрос — одна команда, начинается с `SELECT`, `WITH`, `VALUES`, `TABLE` или `(`, без `INSERT`/`UPDATE`/`DELETE`/`MERGE`/`INTO`, блокировок строк `FOR UPDATE`/`FOR SHARE` и вызовов опасных функций (`dblink`, `pg_sleep`, `pg_advisory_*`, `set_config`, `nextval`, `lo_*`, `pg_read_file`, `query_to_xml` и др.). Нарушение при сохранении — `400 VALIDATION` у поля SQL; при загрузке шаблонов — `400 IMPORT_INVALID`; при формировании, предпросмотре, «Выполнить» и подборе вариантов — `400 SQL_ERROR` до подключения к источнику. Колонки с такими именами берите в двойные кавычки. Подробно — README, «Безопасность источников данных».

### Обновление

- Сохранённые запросы, нарушающие правило, перестанут выполняться, а шаблоны с ними — выгружаться. До обновления проверьте SQL шаблонов и параметров, после обновления исправьте их во вкладках «Данные» и «Параметры» редактора шаблона.
- Рекомендуем подключать источники под пользователем БД только с правом `SELECT` (пример — в README).
```
Затем: `node scripts/changelog-section.mjs 2.16.0` (должен вывести раздел), `pnpm exec prettier --write README.md CHANGELOG.md`.

- [ ] **Step 3: полный прогон** — последовательно, не параллельно:
1. `pnpm test` (все модульные: shared, api, web, carbone, backup-agent)
2. `pnpm test:scripts`
3. `pnpm i18n:check`
4. `pnpm -r typecheck && pnpm typecheck:scripts && pnpm lint`
5. `pnpm --filter @carbone-reports/api test:int` — **без `render-onlyoffice.int.test.ts`**: запускай `vitest run --config vitest.int.config.ts --exclude test/render-onlyoffice.int.test.ts`, затем `test:int:s3` из `apps/api/package.json`.

Отдельно падающий под нагрузкой тест (известно: тайминг storage-gate, отдельные веб-тесты) перезапусти отдельно и укажи в отчёте.

- [ ] **Step 4: commit**
```bash
git add README.md CHANGELOG.md
git commit -m "docs: read-only SQL rule in README and CHANGELOG for 2.16.0" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QhpYjvmQgUdZAFnqrogAEB"
```
