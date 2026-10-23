/** Вид участка SQL: код или содержимое, которое разбор пропускает целиком. */
export type SqlSegmentKind =
  'code' | 'lineComment' | 'blockComment' | 'string' | 'quotedIdent' | 'dollarString';

/** Участок [start, end) исходного текста. */
export interface SqlSegment {
  kind: SqlSegmentKind;
  start: number;
  end: number;
}

/**
 * Символ, который продолжает идентификатор PostgreSQL (ident_cont: `[A-Za-z0-9_$]` и байты
 * 0x80–0xFF, то есть любой не-ASCII символ). Одна проверка для сканера, проверки «только чтение»
 * и разбора параметров — чтобы они не расходились с лексером PostgreSQL.
 */
export function isSqlIdentChar(ch: string | undefined): boolean {
  if (ch === undefined || ch === '') return false;
  return /[A-Za-z0-9_$]/.test(ch) || ch.charCodeAt(0) >= 0x80;
}

/** Тег `$tag$`: как ident_start/ident_cont PostgreSQL, но без `$` внутри. */
const DOLLAR_TAG = /^\$([A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/;

/**
 * Делит SQL на код и пропускаемые участки так же, как лексер PostgreSQL: комментарии `--`
 * и `/* *\/` (с вложенностью), строки `'…'` и `E'…'`, идентификаторы в двойных кавычках,
 * долларовые строки `$tag$…$tag$`. Незакрытый участок тянется до конца текста. Участки идут
 * подряд и покрывают весь текст.
 */
export function scanSql(sql: string): SqlSegment[] {
  const n = sql.length;
  const out: SqlSegment[] = [];
  let codeStart = 0;
  let i = 0;
  // Символ перед pos — часть слова кода; конец предыдущего участка ($tag$ и т. п.) словом не считается.
  const prevIsIdent = (pos: number) => pos > codeStart && isSqlIdentChar(sql[pos - 1]);
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
      // Как в PostgreSQL: комментарий кончается на \n или \r.
      let e = i + 2;
      while (e < n && sql[e] !== '\n' && sql[e] !== '\r') e++;
      skip('lineComment', i, e === n ? n : e + 1);
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
