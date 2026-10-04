import type { ParamsInput, SelectOption, TemplateParam } from '@carbone-reports/shared';

export function initialValues(params: TemplateParam[]): ParamsInput {
  return Object.fromEntries(
    params.map((p) => [p.name, p.defaultValue ?? (p.type === 'boolean' ? false : null)]),
  );
}

/** Значения только для объявленных параметров (устаревшие ключи не уходят на сервер). */
export function pickParams(params: TemplateParam[], values: ParamsInput): ParamsInput {
  return Object.fromEntries(
    params.map((p) => [p.name, Object.hasOwn(values, p.name) ? (values[p.name] ?? null) : null]),
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
