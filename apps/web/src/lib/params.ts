import type { ParamValue, ParamsInput, SelectOption, TemplateParam } from '@carbone-reports/shared';

/** Пустое значение параметра: null, пустая строка или пустой массив. */
export function isEmptyParam(v: ParamValue | undefined): boolean {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);
}

function initialValue(p: TemplateParam): ParamValue {
  const v = p.defaultValue;
  if (Array.isArray(v)) return [...v];
  if (p.multiple && v !== null && typeof v !== 'boolean') return [v];
  return v ?? (p.type === 'boolean' ? false : null);
}

export function initialValues(params: TemplateParam[]): ParamsInput {
  return Object.fromEntries(params.map((p) => [p.name, initialValue(p)]));
}

/** Значения только для объявленных параметров (устаревшие ключи не уходят на сервер). */
export function pickParams(params: TemplateParam[], values: ParamsInput): ParamsInput {
  return Object.fromEntries(
    params.map((p) => {
      const v = Object.hasOwn(values, p.name) ? (values[p.name] ?? null) : null;
      return [p.name, Array.isArray(v) && v.length === 0 ? null : v];
    }),
  );
}

/** «value=label» по строке; без «=» подпись равна значению. */
export function parseOptions(text: string): SelectOption[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const i = line.indexOf('=');
      if (i === -1) return { value: line, label: line };
      const value = line.slice(0, i).trim();
      const label = line.slice(i + 1).trim();
      return { value, label: label || value };
    });
}

export function formatOptions(opts: SelectOption[] | null): string {
  return (opts ?? [])
    .map((o) => (o.label === o.value ? o.value : `${o.value}=${o.label}`))
    .join('\n');
}
