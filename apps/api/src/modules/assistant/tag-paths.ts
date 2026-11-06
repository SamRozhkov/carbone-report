// Сверка путей тегов Carbone с черновиком шаблона (§52.3, §53.2): ключ запроса и режим, колонка из
// проверки SQL, колонка вложенных строк из пробной строки, параметр. Ошибка — текст для модели
// с перечнем допустимых путей.
import type {
  EditorDraft,
  QueryCheck,
  QueryCheckColumn,
  QueryProbe,
  QueryProbeColumn,
} from '@carbone-reports/shared';
import type { Inject } from './tools';

export type PathChecker = (text: string) => Promise<string | null>;

const TAG = /\{([^{}]*)\}/g;
const SEG = String.raw`[^.[\]:\s,()'"|{}]+`;
/**
 * d.<ключ>[индекс].<колонка>[индекс2].<вложенная колонка> — индексы и колонки необязательны;
 * дальше путь не разбираем.
 */
const DATA_PATH = new RegExp(
  String.raw`^d\.(${SEG})(?:\[([^\]]*)\])?(?:\.(${SEG})(?:\[([^\]]*)\](?:\.(${SEG}))?)?)?`,
);
const MAX_PATHS = 80;

/** Вложенные массивы пробной строки; sampled: false — строки не было, колонки неизвестны. */
export interface NestedInfo {
  sampled: boolean;
  nested: { column: string; columns: QueryProbeColumn[] }[];
}

export interface ColumnLookup {
  /** Колонки запроса по queries/check; null — проверка не прошла или эндпоинт не ответил. */
  queryColumns(sql: string): Promise<QueryCheckColumn[] | null>;
  /** Вложенные массивы по queries/probe; null — проба не прошла. */
  nestedColumns(sql: string): Promise<NestedInfo | null>;
}

/**
 * Колонки запросов черновика с кэшем по тексту SQL: один вызов check и probe на запрос.
 * Общий помощник для сверки путей и табличных инструментов.
 */
export function createColumnLookup(ctx: { inject: Inject; templateId: string }): ColumnLookup {
  const base = `/api/templates/${encodeURIComponent(ctx.templateId)}/queries`;
  const checks = new Map<string, Promise<QueryCheckColumn[] | null>>();
  const probes = new Map<string, Promise<NestedInfo | null>>();
  const cached = <T>(map: Map<string, Promise<T>>, sql: string, load: () => Promise<T>) => {
    let p = map.get(sql);
    if (!p) {
      p = load();
      map.set(sql, p);
    }
    return p;
  };
  return {
    queryColumns: (sql) =>
      cached(checks, sql, () =>
        ctx.inject('POST', `${base}/check`, { sql }).then((r) => {
          const c = r.body as QueryCheck | null;
          return r.status === 200 && c?.ok ? c.columns : null;
        }),
      ),
    nestedColumns: (sql) =>
      cached(probes, sql, () =>
        ctx.inject('POST', `${base}/probe`, { sql }).then((r) => {
          const p = r.body as QueryProbe | null;
          return r.status === 200 && p?.ok ? { sampled: p.sampled, nested: p.nested } : null;
        }),
      ),
  };
}

export function createPathChecker(ctx: {
  inject: Inject;
  templateId: string;
  draft: EditorDraft;
}): PathChecker {
  const { draft } = ctx;

  return async (text) => {
    // Кэш проверок и проб — на один вызов.
    const lookup = createColumnLookup(ctx);

    const problems: string[] = [];
    const seen = new Set<string>();
    for (const m of text.matchAll(TAG)) {
      const body = m[1]!.trim();
      // Только данные d.…; c., t(…), $псевдоним и #псевдоним = … не сверяются.
      if (!/^d(?:[.[]|$)/.test(body) || seen.has(m[0])) continue;
      seen.add(m[0]);
      const problem = await checkPath(body, lookup);
      if (problem) problems.push(`${m[0]}: ${problem}`);
    }
    if (!problems.length) return null;

    const paths: string[] = [];
    for (const q of draft.queries) {
      const prefix = q.mode === 'list' ? `d.${q.key}[i].` : `d.${q.key}.`;
      const cols = await lookup.queryColumns(q.sql);
      paths.push(...(cols?.map((c) => c.name) ?? ['<column>']).map((c) => prefix + c));
    }
    paths.push(...draft.params.map((p) => `d.params.${p.name}`));
    const list = paths.length
      ? paths.slice(0, MAX_PATHS).join(', ') + (paths.length > MAX_PATHS ? ', …' : '')
      : 'none — propose queries and parameters first';
    return `invalid tag paths: ${problems.join('; ')}. Valid paths: ${list}`;
  };

  async function checkPath(body: string, lookup: ColumnLookup): Promise<string | null> {
    const m = DATA_PATH.exec(body);
    if (!m) return 'a data path must be d.<query key>… or d.params.<name>';
    const [, key, index, column, subIndex, sub] = m as unknown as [
      string,
      string,
      string?,
      string?,
      string?,
      string?,
    ];
    if (key === 'params') {
      if (index !== undefined || !column || subIndex !== undefined)
        return 'parameters are d.params.<name>';
      return draft.params.some((p) => p.name === column) ? null : `unknown parameter "${column}"`;
    }
    const q = draft.queries.find((x) => x.key === key);
    if (!q) return `unknown query "${key}"`;
    if (q.mode === 'list' && index === undefined)
      return `"${key}" is a list-mode query: use d.${key}[i].${column ?? '<column>'} (and d.${key}[i+1].<column> in the row after)`;
    if (q.mode === 'single' && index !== undefined)
      return `"${key}" is a single-row query: use d.${key}.${column ?? '<column>'} without [i]`;
    if (!column) {
      // {d.key[i+1]} — конец повторяемой строки, колонка не обязательна.
      return index?.includes('+') ? null : 'a column is missing after the query key';
    }
    const cols = await lookup.queryColumns(q.sql);
    // Проверка SQL не прошла или источник недоступен — колонку не сверяем.
    if (cols && !cols.some((c) => c.name === column))
      return `unknown column "${column}" of "${key}"`;
    if (subIndex === undefined) return null;

    // Вложенный цикл строк (§53.2): колонка — массив строк по пробе запроса.
    const probe = await lookup.nestedColumns(q.sql);
    // Проба не прошла или строк нет — вложенный путь принимаем без сверки.
    if (!probe?.sampled) return null;
    const nested = probe.nested.find((n) => n.column === column);
    if (!nested)
      return `"${column}" of "${key}" is not a nested array of rows; build it with json_agg(json_build_object(...))`;
    if (!sub) {
      // {d.key[i].rows[i+1]} — конец вложенной повторяемой строки.
      return subIndex.includes('+') ? null : `a column is missing after "${column}"`;
    }
    // Пустой массив или массив не объектов — колонки неизвестны, не сверяем.
    if (nested.columns.length && !nested.columns.some((c) => c.name === sub))
      return `unknown column "${sub}" of "${key}[i].${column}" (nested rows have: ${nested.columns.map((c) => c.name).join(', ')})`;
    return null;
  }
}
