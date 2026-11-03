// Инструменты формирования в документе (§52.3–52.4): снимок открытого документа, документ
// по описанию и замены значений на теги. Только карточки: документ меняет автор кнопкой.
import type {
  DocBlock,
  DocSnapshot,
  EditorDraft,
  ReplaceItem,
  ReplaceTable,
} from '@carbone-reports/shared';
import { z } from 'zod';
import {
  buildListTable,
  issuesText,
  listQueryError,
  MAX_TAGS_TEXT,
  str,
  TABLE_COLUMNS_SCHEMA,
  TableColumnsArg,
  tagsError,
} from './author-tools';
import type { ToolSpec } from './llm';
import type { PathChecker } from './tag-paths';
import type { AgentTools, ToolContext, ToolOutcome } from './tools';

const NOT_OPEN = 'document is not open — ask the author to open the Document tab';

const SPECS: ToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'get_document',
      description:
        'Text of the template document open in the editor: numbered blocks (paragraphs and tables, n is the block number) of the body, header and footer. No formatting.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_document',
      description:
        'Propose the whole document body built from scratch (a card; the author replaces the document with a button). Blocks: headings, paragraphs with Carbone tags, tables of list-mode queries (the server builds the [i]/[i+1] rows, as in propose_table).',
      parameters: {
        type: 'object',
        properties: {
          blocks: {
            type: 'array',
            description: 'Document blocks, top to bottom (at most 60)',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string', enum: ['heading', 'p', 'table'] },
                level: { type: 'integer', description: 'Only for heading: 1, 2 or 3' },
                text: str('For heading and p: text with Carbone tags'),
                key: str('Only for table: key of a list-mode query'),
                columns: { ...TABLE_COLUMNS_SCHEMA, description: 'Only for table: columns' },
              },
              required: ['type'],
            },
          },
          explanation: str('Short explanation'),
        },
        required: ['blocks', 'explanation'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_replacements',
      description:
        'Turn the filled-in document into a template (a card; the author applies chosen items with a button). items: exact text from the document → Carbone tag, replaced everywhere including header and footer. tables: a document table (block number from get_document) becomes a table of a list-mode query: the first headerRows rows stay, the next row gets the tags of columns, then the [i+1] row; other data rows are removed.',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            description: 'Value replacements (at most 100)',
            items: {
              type: 'object',
              properties: {
                find: str(
                  'Exact text from the document; include neighbouring words when a short value occurs in different meanings',
                ),
                tag: str('Carbone tag, e.g. {d.company.name}'),
                note: str('Optional short note for the author'),
              },
              required: ['find', 'tag'],
            },
          },
          tables: {
            type: 'array',
            description: 'Tables to convert (at most 10)',
            items: {
              type: 'object',
              properties: {
                block: { type: 'integer', description: 'Block number of the table' },
                headerRows: { type: 'integer', description: 'Number of header rows to keep' },
                key: str('Key of a list-mode query'),
                columns: {
                  type: 'array',
                  description:
                    'Query column for every cell of the row, left to right; null keeps the cell text without a tag',
                  items: { type: ['string', 'null'] },
                },
              },
              required: ['block', 'headerRows', 'key', 'columns'],
            },
          },
          explanation: str('Short explanation'),
        },
        required: ['items', 'tables', 'explanation'],
      },
    },
  },
];

const BlockArg = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('heading'),
    level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    text: z.string().max(MAX_TAGS_TEXT),
  }),
  z.object({ type: z.literal('p'), text: z.string().max(MAX_TAGS_TEXT) }),
  z.object({ type: z.literal('table'), key: z.string().min(1).max(200), columns: TableColumnsArg }),
]);

const ARGS = {
  get_document: z.object({}),
  propose_document: z.object({
    blocks: z.array(BlockArg).min(1).max(60),
    explanation: z.string().max(1000),
  }),
  propose_replacements: z.object({
    items: z
      .array(
        z.object({
          find: z.string().min(1).max(500),
          tag: z.string().min(1).max(500),
          note: z.string().max(500).nullish(),
        }),
      )
      .max(100),
    tables: z
      .array(
        z.object({
          block: z.number().int().min(0),
          headerRows: z.number().int().min(0),
          key: z.string().min(1).max(200),
          columns: z.array(z.string().min(1).max(200).nullable()).min(1).max(50),
        }),
      )
      .max(10),
    explanation: z.string().max(1000),
  }),
};

/** Непересекающиеся вхождения подстроки. */
const occurrences = (text: string, find: string) => text.split(find).length - 1;

export function createDocumentTools(
  ctx: ToolContext & {
    templateId: string;
    templateName: string;
    draft: EditorDraft;
    snapshot: DocSnapshot | undefined;
    checkPaths: PathChecker;
  },
): AgentTools {
  const { templateId, templateName, checkPaths } = ctx;

  async function proposeDocument(a: z.infer<typeof ARGS.propose_document>): Promise<ToolOutcome> {
    // Тексты — одной проверкой: синтаксис Carbone и пути (кэш проверки SQL на вызов).
    const texts = a.blocks.flatMap((b) => (b.type === 'table' ? [] : [b.text])).join('\n');
    const error = tagsError(texts) ?? (await checkPaths(texts));
    if (error) return { result: { error } };
    const blocks: DocBlock[] = [];
    for (const b of a.blocks) {
      if (b.type !== 'table') {
        blocks.push(b);
        continue;
      }
      const t = await buildListTable(ctx, 'propose_document', b.key, b.columns);
      if ('error' in t) return { result: { error: t.error } };
      blocks.push({ type: 'table', key: b.key, rows: t.rows });
    }
    return {
      card: { type: 'document', templateId, templateName, blocks, explanation: a.explanation },
      result: { ok: true },
    };
  }

  async function proposeReplacements(
    snapshot: DocSnapshot,
    a: z.infer<typeof ARGS.propose_replacements>,
  ): Promise<ToolOutcome> {
    if (!a.items.length && !a.tables.length) return { result: { error: 'nothing to replace' } };
    const fail = (error: string) => ({ result: { error } });

    // Таблицы: блок-таблица, строка [i] с нужным числом ячеек, колонки запроса-списка.
    const tables: ReplaceTable[] = [];
    for (const t of a.tables) {
      const b = snapshot.blocks[t.block];
      if (!b || b.type !== 'table') return fail(`block ${t.block} is not a table`);
      if (tables.some((x) => x.block === t.block))
        return fail(`table block ${t.block} is listed more than once`);
      const row = b.rows[t.headerRows];
      if (!row)
        return fail(
          `headerRows ${t.headerRows}: table block ${t.block} has ${b.rows.length} rows; a data row must follow the header`,
        );
      if (t.columns.length !== row.length)
        return fail(
          `columns: row ${t.headerRows} of table block ${t.block} has ${row.length} cells, got ${t.columns.length} columns`,
        );
      const named = t.columns.filter((c): c is string => c !== null);
      if (!named.length) return fail('columns: at least one column must be set');
      const error = await listQueryError(ctx, 'propose_replacements', t.key, named);
      if (error) return fail(error);
      const first = t.columns.findIndex((c) => c !== null);
      tables.push({
        block: t.block,
        headerRows: t.headerRows,
        key: t.key,
        fingerprint: { header: b.rows.slice(0, t.headerRows), columns: row.length },
        rowTags: t.columns.map((c) => (c === null ? null : `{d.${t.key}[i].${c}}`)),
        serviceRow: row.map((_, i) => (i === first ? `{d.${t.key}[i+1].${named[0]}}` : '')),
      });
    }

    // Тексты снимка: всё и без строк данных преобразуемых таблиц (они будут удалены).
    const all: string[] = [];
    const kept: string[] = [];
    snapshot.blocks.forEach((b, n) => {
      if (b.type === 'p') {
        all.push(b.text);
        kept.push(b.text);
        return;
      }
      const t = tables.find((x) => x.block === n);
      b.rows.forEach((r, i) => {
        all.push(...r);
        if (!t || i < t.headerRows) kept.push(...r);
      });
    });
    const count = (texts: string[], find: string) =>
      texts.reduce((s, x) => s + occurrences(x, find), 0);

    const problems: string[] = [];
    const items: ReplaceItem[] = [];
    const finds = new Set<string>();
    for (const it of a.items) {
      if (finds.has(it.find)) {
        problems.push(`"${it.find}" is listed more than once`);
        continue;
      }
      finds.add(it.find);
      if (!/\{[^{}]+\}/.test(it.tag)) {
        problems.push(`tag of "${it.find}" must be a Carbone tag like {d.company.name}`);
        continue;
      }
      const n = count(all, it.find);
      if (!n) problems.push(`"${it.find}" not found in the document; copy the exact text`);
      else if (!count(kept, it.find))
        problems.push(
          `"${it.find}" occurs only in data rows of a converted table; those rows are removed`,
        );
      else
        items.push({ find: it.find, tag: it.tag, ...(it.note ? { note: it.note } : {}), count: n });
    }
    if (problems.length) return fail(problems.join('; '));
    const tags = a.items.map((it) => it.tag).join('\n');
    const error = tagsError(tags) ?? (await checkPaths(tags));
    if (error) return fail(error);
    return {
      card: {
        type: 'replace',
        templateId,
        templateName,
        items,
        tables,
        explanation: a.explanation,
      },
      result: { ok: true },
    };
  }

  async function run(name: string, raw: unknown): Promise<ToolOutcome> {
    if (!Object.hasOwn(ARGS, name)) return { result: { error: `unknown tool: ${name}` } };
    const snapshot = ctx.snapshot;
    if (!snapshot) return { result: { error: NOT_OPEN } };
    const parsed = ARGS[name as keyof typeof ARGS].safeParse(raw ?? {});
    if (!parsed.success)
      return { result: { error: `invalid arguments: ${issuesText(parsed.error.issues)}` } };
    switch (name) {
      case 'get_document':
        return {
          result: {
            blocks: snapshot.blocks.map((b, n) =>
              b.type === 'p'
                ? { n, type: b.type, area: b.area, text: b.text }
                : { n, type: b.type, area: b.area, rows: b.rows },
            ),
            truncated: snapshot.truncated,
          },
        };
      case 'propose_document':
        return proposeDocument(parsed.data as z.infer<typeof ARGS.propose_document>);
      default:
        return proposeReplacements(
          snapshot,
          parsed.data as z.infer<typeof ARGS.propose_replacements>,
        );
    }
  }

  return { specs: SPECS, run };
}
