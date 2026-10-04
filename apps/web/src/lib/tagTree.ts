export interface TagNode {
  id: string;
  label: string;
  /** Тег для вставки в шаблон; null — у узла только дочерние теги. */
  tag: string | null;
  /** Для массивов: тег «следующей строки», которым Carbone отмечает конец повторяемого блока. */
  nextRowTag: string | null;
  sample: string | null;
  /** Предупреждение, если ключ нельзя использовать в теге как есть. */
  hint: string | null;
  children: TagNode[];
}

const IDENT = /^[\p{L}_][\p{L}\p{N}_]*$/u;
const BAD_KEY_HINT = 'переименуйте колонку в SQL (латиница, без пробелов)';

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function sampleOf(v: unknown): string {
  const s = v === null ? 'null' : typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}

function node(label: string, path: string, value: unknown): TagNode {
  const hint = IDENT.test(label) ? null : BAD_KEY_HINT;
  if (Array.isArray(value)) {
    const item = `${path}[i]`;
    const first = value.find((x) => x !== null && x !== undefined);
    if (isObject(first)) {
      return {
        id: path,
        label: `${label} []`,
        tag: null,
        nextRowTag: `{${path}[i+1]}`,
        sample: null,
        hint,
        children: Object.entries(first).map(([k, v]) => node(k, `${item}.${k}`, v)),
      };
    }
    return {
      id: path,
      label: `${label} []`,
      tag: `{${item}}`,
      nextRowTag: `{${path}[i+1]}`,
      sample: null,
      hint,
      children: [],
    };
  }
  if (isObject(value)) {
    return {
      id: path,
      label,
      tag: null,
      nextRowTag: null,
      sample: null,
      hint,
      children: Object.entries(value).map(([k, v]) => node(k, `${path}.${k}`, v)),
    };
  }
  return {
    id: path,
    label,
    tag: `{${path}}`,
    nextRowTag: null,
    sample: sampleOf(value),
    hint,
    children: [],
  };
}

export function buildTagTree(data: Record<string, unknown>): TagNode[] {
  return Object.entries(data).map(([k, v]) => node(k, `d.${k}`, v));
}
