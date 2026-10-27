// Авторские инструменты ассистента (§51.3): схема и проверка SQL — через эндпоинты шаблона
// от имени пользователя; предложения — карточки, шаблон не меняется.
import {
  type EditorDraft,
  type QueryCheck,
  TemplateParam,
  TemplateQuery,
} from '@carbone-reports/shared';
import { z } from 'zod';
import { issueMessage } from '../../lib/errors';
import type { ToolSpec } from './llm';
import { type AgentTools, errorOf, type ToolContext, type ToolOutcome } from './tools';

export const AUTHOR_MAX_TOOL_CALLS = 12;
const MAX_TAGS_TEXT = 2000;
const enc = encodeURIComponent;

const str = (description: string) => ({ type: 'string', description });
const PARAM_SCHEMA = {
  type: 'object',
  description:
    'Template parameter: name (identifier), label, type (string|number|date|boolean|select|query), required, defaultValue, options ([{value,label}] for select), sql (for query: returns value,label), multiple.',
  properties: {
    name: { type: 'string' },
    label: { type: 'string' },
    type: { type: 'string' },
    required: { type: 'boolean' },
    multiple: { type: 'boolean' },
    sql: { type: 'string' },
    defaultValue: { type: 'string' },
    options: {
      type: 'array',
      items: {
        type: 'object',
        properties: { value: { type: 'string' }, label: { type: 'string' } },
      },
    },
  },
};

const SPECS: ToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'get_template_design',
      description:
        'Current (possibly unsaved) queries and parameters of the open template, and how query results map to Carbone tag paths.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_tables',
      description:
        'Tables and views of the template data source visible to its database user. search: substring of name or comment.',
      parameters: {
        type: 'object',
        properties: { search: str('Substring of table name or comment') },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'describe_table',
      description:
        'Columns with types, primary key and foreign keys of a table. name: "table" or "schema.table".',
      parameters: {
        type: 'object',
        properties: { name: str('Table name, optionally schema-qualified') },
        required: ['name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'check_sql',
      description:
        'Validate a read-only SQL query against the data source without fetching rows: returns result columns with types, or the error. :name placeholders are parameters.',
      parameters: { type: 'object', properties: { sql: str('SQL query') }, required: ['sql'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_query',
      description:
        'Propose a template query to the author (a card with an apply button). mode: "list" (rows → d.<key>[i]) or "single" (first row → d.<key>). Check the SQL with check_sql first.',
      parameters: {
        type: 'object',
        properties: {
          key: str('Query key: identifier, not "params"'),
          mode: str('list or single'),
          sql: str('Read-only SQL'),
        },
        required: ['key', 'mode', 'sql'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_param',
      description: 'Propose a template parameter to the author (a card with an apply button).',
      parameters: { type: 'object', properties: { param: PARAM_SCHEMA }, required: ['param'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_tags',
      description:
        'Propose a fragment of Carbone tags for the document, with a short explanation (a card with a copy button).',
      parameters: {
        type: 'object',
        properties: { text: str('Tags fragment'), explanation: str('Short explanation') },
        required: ['text', 'explanation'],
      },
    },
  },
];

const ARGS = {
  get_template_design: z.object({}),
  list_tables: z.object({ search: z.string().max(200).optional() }),
  describe_table: z.object({ name: z.string().min(1).max(200) }),
  check_sql: z.object({ sql: z.string().min(1).max(20_000) }),
  propose_query: z.object({ key: z.string(), mode: z.string(), sql: z.string().max(20_000) }),
  propose_param: z.object({ param: z.unknown() }),
  propose_tags: z.object({
    text: z.string().min(1).max(MAX_TAGS_TEXT),
    explanation: z.string().max(1000),
  }),
};

/** Сообщения схемы для модели — по-английски: в issue ключи каталога `v:…`, а не текст. */
const issuesText = (issues: z.core.$ZodIssue[]) =>
  issues
    .map((i) => `${i.path.length ? `${i.path.join('.')}: ` : ''}${issueMessage(i, 'en')}`)
    .join('; ');

const tagPaths = (draft: EditorDraft) => ({
  ...Object.fromEntries(
    draft.queries.map((q) => [
      q.key,
      q.mode === 'single' ? `d.${q.key}.<column>` : `d.${q.key}[i].<column>`,
    ]),
  ),
  params: 'd.params.<name>',
});

export function createAuthorTools(
  ctx: ToolContext & { templateId: string; draft: EditorDraft },
): AgentTools {
  const { inject, templateId, draft } = ctx;
  const base = `/api/templates/${enc(templateId)}`;

  /** Ответ эндпоинта: 200 — как есть (метаданные схемы, итог проверки); иначе — безопасная часть. */
  const call = async (
    tool: string,
    method: 'GET' | 'POST',
    url: string,
    payload?: unknown,
  ): Promise<ToolOutcome> => {
    const r = await (payload === undefined ? inject(method, url) : inject(method, url, payload));
    if (r.status === 200) return { result: r.body };
    ctx.onError?.(tool, r.status, r.body);
    return { result: errorOf(r) };
  };

  async function run(name: string, raw: unknown): Promise<ToolOutcome> {
    // Object.hasOwn: имена из прототипа (constructor, toString) — тоже неизвестные
    if (!Object.hasOwn(ARGS, name)) return { result: { error: `unknown tool: ${name}` } };
    const parsed = ARGS[name as keyof typeof ARGS].safeParse(raw ?? {});
    if (!parsed.success) return { result: { error: `invalid arguments: ${parsed.error.message}` } };
    const a = parsed.data as Record<string, unknown>;
    switch (name) {
      case 'get_template_design':
        return {
          result: { queries: draft.queries, params: draft.params, tagPaths: tagPaths(draft) },
        };
      case 'list_tables': {
        const q = a.search ? `?search=${enc(a.search as string)}` : '';
        return call(name, 'GET', `${base}/schema/tables${q}`);
      }
      case 'describe_table':
        return call(name, 'GET', `${base}/schema/tables/${enc(a.name as string)}`);
      case 'check_sql':
        return call(name, 'POST', `${base}/queries/check`, { sql: a.sql });
      case 'propose_query': {
        // Схема TemplateQuery: ключ-идентификатор, не params, SQL только на чтение.
        const q = TemplateQuery.safeParse({ key: a.key, mode: a.mode, sql: a.sql });
        if (!q.success)
          return { result: { error: `invalid query: ${issuesText(q.error.issues)}` } };
        const r = await inject('POST', `${base}/queries/check`, { sql: q.data.sql });
        if (r.status !== 200) ctx.onError?.(name, r.status, r.body);
        const check: QueryCheck =
          r.status === 200 ? (r.body as QueryCheck) : { ok: false, error: errorOf(r).error };
        return {
          card: {
            type: 'query',
            templateId,
            key: q.data.key,
            mode: q.data.mode,
            sql: q.data.sql,
            check,
          },
        };
      }
      case 'propose_param': {
        const p = TemplateParam.safeParse(a.param);
        if (!p.success)
          return { result: { error: `invalid parameter: ${issuesText(p.error.issues)}` } };
        return { card: { type: 'param', templateId, param: p.data } };
      }
      default:
        return {
          card: {
            type: 'tags',
            templateId,
            text: a.text as string,
            explanation: a.explanation as string,
          },
        };
    }
  }

  return { specs: SPECS, run };
}
