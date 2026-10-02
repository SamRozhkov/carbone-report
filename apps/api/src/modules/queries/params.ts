import { DATE_RE, type ParamValue, type ParamsInput, type TemplateParam } from '@carbone-reports/shared';
import { AppError } from '../../lib/errors';

function isValidDate(v: string): boolean {
  if (!DATE_RE.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** Возвращает текст ошибки или null, если значение подходит под тип. */
function checkValue(def: TemplateParam, v: Exclude<ParamValue, null>): string | null {
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

const isEmpty = (v: ParamValue | undefined): v is null | undefined | '' =>
  v === undefined || v === null || v === '';

function fail(fields: Record<string, string>): never {
  throw new AppError('VALIDATION', 400, 'неверные параметры', { fields });
}

export function resolveParams(defs: TemplateParam[], input: ParamsInput): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  const fields: Record<string, string> = {};
  for (const def of defs) {
    const raw = Object.hasOwn(input, def.name) ? input[def.name] : undefined;
    const value = isEmpty(raw) ? def.defaultValue : raw;
    if (isEmpty(value)) {
      if (def.required) fields[def.name] = 'обязательный параметр';
      out[def.name] = null;
      continue;
    }
    const err = checkValue(def, value);
    if (err) fields[def.name] = err;
    else out[def.name] = value;
  }
  if (Object.keys(fields).length > 0) fail(fields);
  return out;
}

export function checkParamDefaults(defs: TemplateParam[]): void {
  const fields: Record<string, string> = {};
  for (const def of defs) {
    if (isEmpty(def.defaultValue)) continue;
    const err = checkValue(def, def.defaultValue);
    if (err) fields[def.name] = `значение по умолчанию: ${err}`;
  }
  if (Object.keys(fields).length > 0) fail(fields);
}
