export interface ParsedSql {
  text: string;
  names: string[];
}

export class SqlParamError extends Error {}

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;
const DOLLAR_TAG = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;

/**
 * Заменяет :name на $n, пропуская строки, идентификаторы в кавычках, комментарии и ::cast.
 * `:name` — параметр, только если перед `:` не идентификатор/цифра (иначе это срез массива a[1:n]).
 */
export function parseSqlParams(sql: string): ParsedSql {
  const names: string[] = [];
  const n = sql.length;
  let out = '';
  let i = 0;

  const copyTo = (end: number) => {
    const e = Math.min(end, n);
    out += sql.slice(i, e);
    i = e;
  };
  const prevIsIdent = (pos: number) => pos > 0 && IDENT_PART.test(sql[pos - 1]!);

  while (i < n) {
    const c = sql[i]!;
    const next = sql[i + 1];

    if (c === '-' && next === '-') {
      const e = sql.indexOf('\n', i);
      copyTo(e === -1 ? n : e + 1);
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
      copyTo(j);
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
      copyTo(j);
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
      copyTo(j);
      continue;
    }

    if (c === '$' && !prevIsIdent(i)) {
      const m = DOLLAR_TAG.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        copyTo(end === -1 ? n : end + tag.length);
        continue;
      }
      if (next !== undefined && /[0-9]/.test(next)) {
        throw new SqlParamError('используйте именованные параметры :name вместо $1');
      }
    }

    if (c === ':') {
      if (next === ':') {
        out += '::';
        i += 2;
        continue;
      }
      if (next !== undefined && IDENT_START.test(next) && !prevIsIdent(i)) {
        let j = i + 1;
        while (j < n && IDENT_PART.test(sql[j]!)) j++;
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

  return { text: out, names };
}
