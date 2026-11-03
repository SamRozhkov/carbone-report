// Сверка путей тегов Carbone с черновиком шаблона (§52.3): ключ запроса и режим, колонка из
// проверки SQL, параметр. Ошибка — текст для модели с перечнем допустимых путей.
import type { EditorDraft, QueryCheck } from '@carbone-reports/shared';
import type { Inject } from './tools';

export type PathChecker = (text: string) => Promise<string | null>;

const TAG = /\{([^{}]*)\}/g;
const SEG = String.raw`[^.[\]:\s,()'"|{}]+`;
/** d.<ключ>[индекс].<колонка> — индекс и колонка необязательны; дальше путь не разбираем. */
const DATA_PATH = new RegExp(String.raw`^d\.(${SEG})(?:\[([^\]]*)\])?(?:\.(${SEG}))?`);
const MAX_PATHS = 80;

export function createPathChecker(ctx: {
  inject: Inject;
  templateId: string;
  draft: EditorDraft;
}): PathChecker {
  const { inject, draft } = ctx;
  const url = `/api/templates/${encodeURIComponent(ctx.templateId)}/queries/check`;

  return async (text) => {
    // Кэш проверок SQL — на один вызов: колонки запроса, null — проверка не прошла.
    const cache = new Map<string, Promise<string[] | null>>();
    const columnsOf = (q: EditorDraft['queries'][number]) => {
      let p = cache.get(q.key);
      if (!p) {
        p = inject('POST', url, { sql: q.sql }).then((r) => {
          const c = r.body as QueryCheck | null;
          return r.status === 200 && c?.ok ? c.columns.map((x) => x.name) : null;
        });
        cache.set(q.key, p);
      }
      return p;
    };

    const problems: string[] = [];
    const seen = new Set<string>();
    for (const m of text.matchAll(TAG)) {
      const body = m[1]!.trim();
      // Только данные d.…; c., t(…), $псевдоним и #псевдоним = … не сверяются.
      if (!/^d(?:[.[]|$)/.test(body) || seen.has(m[0])) continue;
      seen.add(m[0]);
      const problem = await checkPath(body, columnsOf);
      if (problem) problems.push(`${m[0]}: ${problem}`);
    }
    if (!problems.length) return null;

    const paths: string[] = [];
    for (const q of draft.queries) {
      const prefix = q.mode === 'list' ? `d.${q.key}[i].` : `d.${q.key}.`;
      const cols = await columnsOf(q);
      paths.push(...(cols ?? ['<column>']).map((c) => prefix + c));
    }
    paths.push(...draft.params.map((p) => `d.params.${p.name}`));
    const list = paths.length
      ? paths.slice(0, MAX_PATHS).join(', ') + (paths.length > MAX_PATHS ? ', …' : '')
      : 'none — propose queries and parameters first';
    return `invalid tag paths: ${problems.join('; ')}. Valid paths: ${list}`;
  };

  async function checkPath(
    body: string,
    columnsOf: (q: EditorDraft['queries'][number]) => Promise<string[] | null>,
  ): Promise<string | null> {
    const m = DATA_PATH.exec(body);
    if (!m) return 'a data path must be d.<query key>… or d.params.<name>';
    const [, key, index, column] = m as unknown as [string, string, string?, string?];
    if (key === 'params') {
      if (index !== undefined || !column) return 'parameters are d.params.<name>';
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
    const cols = await columnsOf(q);
    // Проверка SQL не прошла или источник недоступен — колонку не сверяем.
    if (cols && !cols.includes(column)) return `unknown column "${column}" of "${key}"`;
    return null;
  }
}
