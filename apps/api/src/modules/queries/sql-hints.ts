import { sqlCompareRefs, type ParamValue } from '@carbone-reports/shared';
import type { Msg } from '../../lib/errors';

// Ошибки приведения/сравнения типов: массив против скаляра и наоборот.
const TYPE_ERRORS = new Set(['22P02', '42883', '42804']);

/**
 * Подсказка к ошибке Postgres, если она похожа на путаницу `= :имя` и `= any(:имя)`.
 * Срабатывает только по явным признакам в SQL; used — имена из parseSqlParams.
 */
export function sqlParamHint(
  sql: string,
  used: string[],
  params: Record<string, ParamValue>,
  e: unknown,
): Msg | undefined {
  const err = e as { code?: unknown; message?: unknown } | null | undefined;
  const code = err?.code;
  const refs = sqlCompareRefs(sql);
  if (code === '42601' && refs.missingOperator && /near "any"/i.test(String(err?.message))) {
    return { key: 'sql.hintMissingOperator' };
  }
  if (typeof code !== 'string' || !TYPE_ERRORS.has(code)) return undefined;

  const arrays = used.filter((n) => Array.isArray(params[n]) && refs.scalar.includes(n));
  if (arrays.length === 1) {
    const n = arrays[0]!;
    return { key: 'sql.hintArray', params: { name: n } };
  }
  if (arrays.length > 1) {
    const list = arrays.map((n) => `:${n}`).join(', ');
    return { key: 'sql.hintArrays', params: { list } };
  }
  // Строка в any(:имя) может быть корректным литералом массива '{a,b}' — подсказываем,
  // только если Postgres сам не смог разобрать её как массив.
  const malformed = /malformed array literal/i.test(String(err?.message));
  const single = used.find((n) => {
    const v = params[n];
    return refs.any.includes(n) && (typeof v === 'number' || (typeof v === 'string' && malformed));
  });
  if (single) return { key: 'sql.hintScalar', params: { name: single } };
  return undefined;
}
