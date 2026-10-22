import {
  DATE_RE,
  type ParamValue,
  type ParamsInput,
  type TemplateParam,
} from '@carbone-reports/shared';
import { AppError, text, type Text } from '../../lib/errors';

function isValidDate(v: string): boolean {
  if (!DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

const isScalar = (v: unknown): v is string | number =>
  typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v));

/** Возвращает текст ошибки или null, если значение подходит под тип. */
function checkValue(def: TemplateParam, v: Exclude<ParamValue, null>): Text | null {
  const err = (key: string) => text(`param.${key}`);
  if (def.type === 'query') {
    if (def.multiple) return Array.isArray(v) && v.every(isScalar) ? null : err('expectedList');
    return isScalar(v) ? null : err('expectedOne');
  }
  if (Array.isArray(v)) return err('invalidValue');
  switch (def.type) {
    case 'string':
      return typeof v === 'string' ? null : err('expectedString');
    case 'number':
      return typeof v === 'number' && Number.isFinite(v) ? null : err('expectedNumber');
    case 'date':
      return typeof v === 'string' && isValidDate(v) ? null : err('expectedDate');
    case 'boolean':
      return typeof v === 'boolean' ? null : err('expectedBoolean');
    case 'select':
      return typeof v === 'string' && (def.options ?? []).some((o) => o.value === v)
        ? null
        : err('invalidValue');
  }
}

/** Отсутствующее значение: undefined, null, '' и пустой список. */
export function isEmptyValue(v: ParamValue | undefined): v is null | undefined | '' | [] {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

function fail(fields: Record<string, Text>): never {
  throw new AppError('VALIDATION', 400, { key: 'param.invalid' }, { fields });
}

/**
 * Типовая проверка одного параметра: пустое значение заменяется на default, затем на null.
 * Возвращает итоговое значение и текст ошибки (null — ошибки нет).
 */
export function checkParam(
  def: TemplateParam,
  raw: ParamValue | undefined,
): { value: ParamValue; error: Text | null } {
  const value = isEmptyValue(raw) ? def.defaultValue : raw;
  if (isEmptyValue(value)) {
    return { value: null, error: def.required ? text('param.required') : null };
  }
  const error = checkValue(def, value);
  return { value: error ? null : value, error };
}

export function resolveParams(
  defs: TemplateParam[],
  input: ParamsInput,
): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  const fields: Record<string, Text> = {};
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
  const fields: Record<string, Text> = {};
  for (const def of defs) {
    if (isEmptyValue(def.defaultValue)) continue;
    const err = checkValue(def, def.defaultValue);
    if (err) fields[def.name] = text('param.defaultInvalid', { message: err });
  }
  if (Object.keys(fields).length > 0) fail(fields);
}
