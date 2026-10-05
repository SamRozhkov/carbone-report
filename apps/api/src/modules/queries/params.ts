import {
  DATE_RE,
  type ParamValue,
  type ParamsInput,
  type TemplateParam,
} from '@carbone-reports/shared';
import { AppError } from '../../lib/errors';

function isValidDate(v: string): boolean {
  if (!DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

const isScalar = (v: unknown): v is string | number =>
  typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));

/** Возвращает текст ошибки или null, если значение подходит под тип. */
function checkValue(def: TemplateParam, v: Exclude<ParamValue, null>): string | null {
  if (def.type === 'query') {
    if (def.multiple)
      return Array.isArray(v) && v.every(isScalar) ? null : 'ожидается список значений';
    return isScalar(v) ? null : 'ожидается одно значение';
  }
  if (Array.isArray(v)) return 'недопустимое значение';
  switch (def.type) {
    case 'string':
      return typeof v === 'string' ? null : 'ожидается строка';
    case 'number':
      return typeof v === 'number' && Number.isFinite(v) ? null : 'ожидается число';
    case 'date':
      return typeof v === 'string' && isValidDate(v) ? null : 'ожидается дата ГГГГ-ММ-ДД';
    case 'boolean':
      return typeof v === 'boolean' ? null : 'ожидается да/нет';
    case 'select':
      return typeof v === 'string' && (def.options ?? []).some((o) => o.value === v)
        ? null
        : 'недопустимое значение';
  }
}

/** Отсутствующее значение: undefined, null, '' и пустой список. */
export function isEmptyValue(v: ParamValue | undefined): v is null | undefined | '' | [] {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

function fail(fields: Record<string, string>): never {
  throw new AppError('VALIDATION', 400, 'неверные параметры', { fields });
}

/**
 * Типовая проверка одного параметра: пустое значение заменяется на default, затем на null.
 * Возвращает итоговое значение и текст ошибки (null — ошибки нет).
 */
export function checkParam(
  def: TemplateParam,
  raw: ParamValue | undefined,
): { value: ParamValue; error: string | null } {
  const value = isEmptyValue(raw) ? def.defaultValue : raw;
  if (isEmptyValue(value)) {
    return { value: null, error: def.required ? 'обязательный параметр' : null };
  }
  const error = checkValue(def, value);
  return { value: error ? null : value, error };
}

export function resolveParams(
  defs: TemplateParam[],
  input: ParamsInput,
): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  const fields: Record<string, string> = {};
  for (const def of defs) {
    const { value, error } = checkParam(
      def,
      Object.hasOwn(input, def.name) ? input[def.name] : undefined,
    );
    if (error) fields[def.name] = error;
    else out[def.name] = value;
  }
  if (Object.keys(fields).length > 0) fail(fields);
  return out;
}

export function checkParamDefaults(defs: TemplateParam[]): void {
  const fields: Record<string, string> = {};
  for (const def of defs) {
    if (isEmptyValue(def.defaultValue)) continue;
    const err = checkValue(def, def.defaultValue);
    if (err) fields[def.name] = `значение по умолчанию: ${err}`;
  }
  if (Object.keys(fields).length > 0) fail(fields);
}
