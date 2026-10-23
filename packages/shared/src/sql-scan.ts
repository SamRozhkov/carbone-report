/** Вид участка SQL: код или содержимое, которое разбор пропускает целиком. */
export type SqlSegmentKind =
  'code' | 'lineComment' | 'blockComment' | 'string' | 'quotedIdent' | 'dollarString';

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
