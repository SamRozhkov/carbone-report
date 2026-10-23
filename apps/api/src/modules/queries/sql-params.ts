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
