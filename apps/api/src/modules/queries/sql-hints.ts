import { sqlAnyRefs, type ParamValue } from '@carbone-reports/shared';

// Ошибки приведения/сравнения типов: массив против скаляра и наоборот.
const TYPE_ERRORS = new Set(['22P02', '42883', '42804']);

/** used — имена из parseSqlParams. Подсказка к ошибке Postgres, если она похожа на путаницу `= :имя` и `= any(:имя)`. */
export function sqlParamHint(
  sql: string,
  used: string[],
  params: Record<string, ParamValue>,
  e: unknown,
): string | undefined {
  const code = (e as { code?: string }).code;
  const message = (e as Error).message ?? '';
  if (code === '42601' && /near "any"/i.test(message)) {
    return 'перед any нужен оператор сравнения: = any(:имя)';
  }
  if (!code || !TYPE_ERRORS.has(code)) return undefined;

  const inAny = new Set(sqlAnyRefs(sql));
  const arrays = used.filter((n) => Array.isArray(params[n]) && !inAny.has(n));
  if (arrays.length === 1) {
    const n = arrays[0]!;
    return `параметр :${n} — множественный выбор: сравнивайте через = any(:${n})`;
  }
  if (arrays.length > 1) {
    const list = arrays.map((n) => `:${n}`).join(', ');
    return `параметры ${list} — множественный выбор: сравнивайте через = any(:имя)`;
  }
  const scalar = used.find((n) => inAny.has(n) && params[n] !== null && !Array.isArray(params[n]));
  if (scalar) return `параметр :${scalar} — одно значение: сравнивайте через = :${scalar}`;
  return undefined;
}
