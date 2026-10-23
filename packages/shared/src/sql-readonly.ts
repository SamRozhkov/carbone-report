import { isSqlIdentChar, scanSql } from './sql-scan';

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
  'ts_stat',
  'ts_rewrite',
  'crosstab*', // tablefunc
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
  's',
);

const FIRST_WORDS = new Set(['SELECT', 'WITH', 'VALUES', 'TABLE']);
const FORBIDDEN_WORDS = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'INTO']);
const LOCK_CLAUSES = [['UPDATE'], ['NO', 'KEY', 'UPDATE'], ['SHARE'], ['KEY', 'SHARE']];

/** ident_start PostgreSQL: буква, `_` или не-ASCII символ. */
const isWordStart = (ch: string | undefined) =>
  ch !== undefined && (/[A-Za-z_]/.test(ch) || ch.charCodeAt(0) >= 0x80);
/** Пробельные символы лексера PostgreSQL; прочие (например, U+00A0) — часть идентификатора. */
const PG_SPACE = /[ \t\n\r\f\v]/;
/** Число: цифры с `_`, дробная часть, порядок. Слово сразу за числом — отдельный токен. */
const NUMBER = /[0-9][0-9_]*(?:\.[0-9_]*)?(?:[eE][+-]?[0-9][0-9_]*)?/y;
const MAX_FOUND = 40;

type Tok =
  | { t: 'word'; v: string } // слово без кавычек, v — как в тексте
  | { t: 'name'; v: string; u?: boolean } // идентификатор в двойных кавычках, v — без кавычек
  | { t: 'punct'; v: string }
  | { t: 'lit'; v: string } // строка, долларовая строка, число
  | { t: 'param'; v: string };

/** U&"…": `\XXXX`, `\+XXXXXX`, `\\` (символ экранирования по умолчанию). */
function decodeUnicodeEscapes(s: string): string {
  return s.replace(
    /\\(?:([0-9a-fA-F]{4})|\+([0-9a-fA-F]{6})|(\\))/g,
    (m, h4?: string, h6?: string, bs?: string) => {
      if (bs) return '\\';
      const cp = parseInt((h4 ?? h6)!, 16);
      return cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    },
  );
}

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
      const body = raw.slice(1, closed ? -1 : undefined).replaceAll('""', '"');
      const a = toks[toks.length - 2];
      const b = toks[toks.length - 1];
      const isU =
        seg.start >= 2 &&
        sql[seg.start - 1] === '&' &&
        b?.t === 'punct' &&
        b.v === '&' &&
        a?.t === 'word' &&
        a.v.toUpperCase() === 'U' &&
        (seg.start < 3 || !isSqlIdentChar(sql[seg.start - 3]));
      if (isU) {
        toks.length -= 2;
        toks.push({ t: 'name', v: decodeUnicodeEscapes(body), u: true });
      } else toks.push({ t: 'name', v: body });
      continue;
    }
    let i = seg.start;
    while (i < seg.end) {
      const c = sql[i]!;
      if (PG_SPACE.test(c)) {
        i++;
        continue;
      }
      if (isWordStart(c)) {
        let j = i + 1;
        while (j < seg.end && isSqlIdentChar(sql[j])) j++;
        toks.push({ t: 'word', v: sql.slice(i, j) });
        i = j;
        continue;
      }
      if (/[0-9]/.test(c)) {
        NUMBER.lastIndex = i;
        const j = Math.min(seg.end, i + NUMBER.exec(sql)![0].length);
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
        if (next !== undefined && i + 1 < seg.end && isWordStart(next) && !isSqlIdentChar(prev)) {
          let j = i + 2;
          while (j < seg.end && isSqlIdentChar(sql[j])) j++;
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
/** found попадает в текст ошибки: длиннее MAX_FOUND символов — обрезается с «…». */
const fail = (found: string): ReadOnlySqlCheck => {
  const chars = [...found];
  return {
    ok: false,
    found: chars.length > MAX_FOUND ? chars.slice(0, MAX_FOUND).join('') + '…' : found,
  };
};

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
        const lock = LOCK_CLAUSES.find((words) =>
          words.every((lw, n) => isWord(body[k + 1 + n], lw)),
        );
        if (lock) return fail(['FOR', ...lock].join(' '));
      }
      if (FORBIDDEN_WORDS.has(w)) return fail(w);
    }
    if (x.t === 'name' && x.u && isWord(body[k + 1], 'UESCAPE')) return fail('UESCAPE');
    if (
      (x.t === 'word' || x.t === 'name' || x.t === 'param') &&
      body[k + 1]?.t === 'punct' &&
      body[k + 1]!.v === '('
    ) {
      const name = (x.t === 'param' ? x.v.slice(1) : x.v).toLowerCase();
      if (FORBIDDEN_RE.test(name)) return fail(name);
    }
  }
  return { ok: true };
}
