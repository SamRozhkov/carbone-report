export interface TagNode {
  id: string;
  label: string;
  /** Тег для вставки в шаблон; null — у узла только дочерние теги. */
  tag: string | null;
  /** Для массивов: тег «следующей строки», которым Carbone отмечает конец повторяемого блока. */
  nextRowTag: string | null;
  sample: string | null;
  /** Ключ нельзя использовать в теге как есть (не идентификатор) — панель показывает подсказку. */
  badKey: boolean;
  children: TagNode[];
}

const IDENT = /^[\p{L}_][\p{L}\p{N}_]*$/u;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function sampleOf(v: unknown): string {
  const s = v === null ? 'null' : typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}

function node(label: string, path: string, value: unknown): TagNode {
  const badKey = !IDENT.test(label);
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
        badKey,
        children: Object.entries(first).map(([k, v]) => node(k, `${item}.${k}`, v)),
      };
    }
    return {
      id: path,
      label: `${label} []`,
      tag: `{${item}}`,
      nextRowTag: `{${path}[i+1]}`,
      sample: null,
      badKey,
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
      badKey,
      children: Object.entries(value).map(([k, v]) => node(k, `${path}.${k}`, v)),
    };
  }
  return {
    id: path,
    label,
    tag: `{${path}}`,
    nextRowTag: null,
    sample: sampleOf(value),
    badKey,
    children: [],
  };
}

export function buildTagTree(data: Record<string, unknown>): TagNode[] {
  return Object.entries(data).map(([k, v]) => node(k, `d.${k}`, v));
}
