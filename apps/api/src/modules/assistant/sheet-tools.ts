// Инструменты формирования в таблице (§53.2–53.3): снимок активного листа и лист по описанию.
// Только карточки: лист меняет автор кнопкой. Раскладку и теги строит сервер, модель задаёт ключ,
// колонки и группировку.
import {
  type EditorDraft,
  type QueryCheckColumn,
  type QueryProbeColumn,
  SheetDeclaredType,
  type SheetSnapshot,
} from '@carbone-reports/shared';
import { z } from 'zod';
import {
  BAD_PATH,
  type DraftContext,
  formulaError,
  issuesText,
  listQueryError,
  pathError,
  str,
  tagsError,
} from './author-tools';
import type { ToolSpec } from './llm';
import {
  buildSheetLayout,
  columnKind,
  type GroupedTableSpec,
  nestedColumnKind,
  type SheetColumn,
  sheetLabels,
  type SimpleTableSpec,
} from './sheet-layout';
import { createColumnLookup, memoInject, type PathChecker } from './tag-paths';
import type { AgentTools, ToolContext, ToolOutcome } from './tools';

const NOT_OPEN = 'spreadsheet is not open — ask the author to open the Document tab';
const NESTED_HINT =
  "build the nested rows in SQL with json_agg(json_build_object(...)), e.g. select contractor, json_agg(json_build_object('date', date, 'sum', sum) order by date) as rows from … group by contractor, and propose that query first";

const LIMITS = { header: 20, columns: 20, group: 5 } as const;

const SHEET_COLUMN_ITEMS = {
  type: 'object',
  properties: {
    column: str(
      'Result column of the query (for a table with subtotals: a column of the nested rows)',
    ),
    label: str('Column header text'),
    type: {
      type: 'string',
      enum: SheetDeclaredType.options,
      description:
        'Optional, only for nested row columns: text, int, decimal or date; used when the query returns no rows to check the types',
    },
  },
  required: ['column', 'label'],
};

const SPECS: ToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'get_sheet',
      description:
        'Text of the active sheet of the spreadsheet open in the editor: non-empty cells of the used range with A1 addresses, the active cell. No formatting.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_sheet',
      description:
        'Propose the whole active sheet built from scratch (a card; the author replaces the sheet with a button): optional title, label/value rows above the table, and a table of a list-mode query. The server builds the cells, Carbone tags, number and date formats, totals and subtotals (Carbone aggregators, no Excel formulas). Simple table: key and columns (total optional). Table with subtotals: the query returns one row per group with the group columns and a nested array of rows (json_agg); set group, rows, columns of the nested rows, subtotal and total optional.',
      parameters: {
        type: 'object',
        properties: {
          title: str('Optional sheet title (cell A1)'),
          header: {
            type: 'array',
            description: `Rows above the table (at most ${LIMITS.header}): label in column A, value in column B`,
            items: {
              type: 'object',
              properties: {
                label: str('Label text, e.g. Period:'),
                value: str('Text with Carbone tags, e.g. {d.params.from} — {d.params.to}'),
              },
              required: ['label', 'value'],
            },
          },
          table: {
            type: 'object',
            description: 'The table',
            properties: {
              key: str('Key of a list-mode query of the template'),
              columns: {
                type: 'array',
                description: `Table columns, left to right (1 to ${LIMITS.columns}); with subtotals — columns of the nested rows`,
                items: SHEET_COLUMN_ITEMS,
              },
              group: {
                type: 'array',
                description: `Only with subtotals: group columns of the query row (1 to ${LIMITS.group})`,
                items: {
                  type: 'object',
                  properties: {
                    column: str('Result column of the query'),
                    label: str('Column header text'),
                  },
                  required: ['column', 'label'],
                },
              },
              rows: str(
                'Only with subtotals: the query column holding the nested array of rows; empty string for a simple table',
              ),
              subtotal: {
                type: 'array',
                description:
                  'Only with subtotals: numeric columns of the nested rows summed per group',
                items: { type: 'string' },
              },
              total: {
                type: 'array',
                description: 'Numeric columns summed in the total row',
                items: { type: 'string' },
              },
            },
            required: ['key', 'columns'],
          },
          explanation: str('Short explanation'),
        },
        required: ['table', 'explanation'],
      },
    },
  },
];

/** Пустая строка и null от строгих моделей — «не задано». */
const unset = (v: unknown) => (v === '' || v === null ? undefined : v);
const Label = z.string().max(200);
const ColumnName = z.string().min(1).max(200);
const ColumnList = z.array(ColumnName).max(LIMITS.columns).nullish();

const ARGS = {
  get_sheet: z.object({}),
  propose_sheet: z.object({
    title: z.string().max(200).nullish(),
    header: z
      .array(z.object({ label: Label, value: z.string().max(500) }))
      .max(LIMITS.header)
      .nullish(),
    table: z.object({
      key: z.string().min(1).max(200),
      columns: z
        .array(
          z.object({
            column: ColumnName,
            label: Label,
            type: z.preprocess(unset, SheetDeclaredType.optional()),
          }),
        )
        .min(1)
        .max(LIMITS.columns),
      group: z
        .array(z.object({ column: ColumnName, label: Label }))
        .max(LIMITS.group)
        .nullish(),
      rows: z.string().max(200).nullish(),
      subtotal: ColumnList,
      total: ColumnList,
    }),
    explanation: z.string().max(1000),
  }),
};
type SheetArgs = z.infer<typeof ARGS.propose_sheet>;
type TableArgs = SheetArgs['table'];

/** Колонки запроса черновика по queries/check; null — нет запроса или проверка не дала колонок. */
export async function queryColumns(
  ctx: DraftContext,
  key: string,
): Promise<QueryCheckColumn[] | null> {
  const q = ctx.draft.queries.find((x) => x.key === key);
  return q ? createColumnLookup(ctx).queryColumns(q.sql) : null;
}

/**
 * Вложенные строки колонки запроса по пробной строке (§53.2). sampled: false — проба не прошла
 * или строк нет: колонки неизвестны, путь принимается. columns: null — колонка не массив строк;
 * [] — массив пуст или не из объектов, колонки неизвестны.
 */
export type NestedRows = { sampled: false } | { sampled: true; columns: QueryProbeColumn[] | null };

export async function nestedColumns(
  ctx: DraftContext,
  key: string,
  column: string,
): Promise<NestedRows> {
  const q = ctx.draft.queries.find((x) => x.key === key);
  const probe = q ? await createColumnLookup(ctx).nestedColumns(q.sql) : null;
  if (!probe?.sampled) return { sampled: false };
  return { sampled: true, columns: probe.nested.find((n) => n.column === column)?.columns ?? null };
}

const isNumeric = (kind: SheetColumn['kind']) => kind === 'integer' || kind === 'decimal';
const uniq = (xs: string[] | null | undefined) => [...new Set(xs ?? [])];

/** Колонки итогов: из колонок таблицы и числовые; текст ошибки для модели или null. */
function aggregatesError(field: string, list: string[], columns: SheetColumn[]): string | null {
  for (const name of list) {
    const c = columns.find((x) => x.column === name);
    if (!c)
      return `${field}: "${name}" is not one of the table columns (${columns.map((x) => x.column).join(', ')})`;
    if (!isNumeric(c.kind)) return `${field}: "${name}" is not a numeric column (type ${c.kind})`;
  }
  return null;
}

export function createSheetTools(
  ctx: ToolContext & {
    templateId: string;
    templateName: string;
    draft: EditorDraft;
    snapshot: SheetSnapshot | undefined;
    checkPaths: PathChecker;
  },
): AgentTools {
  const { templateId, templateName, checkPaths } = ctx;
  const TOOL = 'propose_sheet';

  /** Простая таблица: колонки и типы — из проверки SQL. */
  async function simpleTable(
    c: DraftContext,
    t: TableArgs,
  ): Promise<SimpleTableSpec | { error: string }> {
    const error = await listQueryError(
      c,
      TOOL,
      t.key,
      t.columns.map((x) => x.column),
    );
    if (error) return { error };
    const types = (await queryColumns(c, t.key)) ?? [];
    const columns: SheetColumn[] = t.columns.map((x) => ({
      column: x.column,
      label: x.label,
      kind: columnKind(types.find((y) => y.name === x.column)?.type ?? ''),
    }));
    const total = uniq(t.total);
    const bad = aggregatesError('total', total, columns);
    return bad ? { error: bad } : { key: t.key, columns, total };
  }

  /**
   * Таблица с подитогами: колонки группы и колонка вложенных строк — из проверки SQL, колонки
   * вложенных строк — из пробной строки; строк нет — тип, объявленный моделью (F8).
   */
  async function groupedTable(
    c: DraftContext,
    t: TableArgs,
    rows: string,
    group: { column: string; label: string }[],
  ): Promise<GroupedTableSpec | { error: string }> {
    const error = await listQueryError(c, TOOL, t.key, [...group.map((g) => g.column), rows]);
    if (error) return { error };
    if (group.some((g) => g.column === rows))
      return { error: `group: "${rows}" is the column of nested rows, not a group column` };
    const nested = await nestedColumns(c, t.key, rows);
    if (nested.sampled && nested.columns === null)
      return { error: `"${rows}" of "${t.key}" is not a nested array of rows; ${NESTED_HINT}` };
    // Пустой массив в пробной строке — колонки неизвестны, как без строк.
    const known = nested.sampled && nested.columns?.length ? nested.columns : null;
    if (known) {
      const unknown = t.columns.filter((x) => !known.some((k) => k.name === x.column));
      if (unknown.length)
        return {
          error: `unknown columns ${unknown.map((x) => x.column).join(', ')} of the nested rows "${t.key}[i].${rows}" (nested rows have: ${known.map((k) => k.name).join(', ')})`,
        };
    }
    const badName = t.columns.find((x) => BAD_PATH.test(x.column));
    if (badName) return { error: pathError(badName.column) };

    const types = (await queryColumns(c, t.key)) ?? [];
    const subtotal = uniq(t.subtotal);
    const total = uniq(t.total);
    const columns: SheetColumn[] = t.columns.map((x) => ({
      column: x.column,
      label: x.label,
      kind: nestedColumnKind({
        sampled: !!known,
        probed: known?.find((k) => k.name === x.column),
        declared: x.type,
        aggregated: subtotal.includes(x.column) || total.includes(x.column),
      }),
    }));
    const bad =
      aggregatesError('subtotal', subtotal, columns) ?? aggregatesError('total', total, columns);
    if (bad) return { error: bad };
    return {
      key: t.key,
      group: group.map((g) => ({
        column: g.column,
        label: g.label,
        kind: columnKind(types.find((y) => y.name === g.column)?.type ?? ''),
      })),
      rows,
      columns,
      subtotal,
      total,
    };
  }

  async function proposeSheet(a: SheetArgs): Promise<ToolOutcome> {
    const fail = (error: string) => ({ result: { error } });
    const t = a.table;
    const header = a.header ?? [];
    const group = t.group ?? [];
    const rows = t.rows?.trim() ?? '';
    const title = a.title?.trim() || undefined;

    // Все тексты листа от модели: ни формул, ни чужого синтаксиса, пути — из черновика.
    const texts = [
      title ?? '',
      ...header.flatMap((h) => [h.label, h.value]),
      ...group.map((g) => g.label),
      ...t.columns.map((x) => x.label),
    ];
    const formula = formulaError(texts);
    if (formula) return fail(formula);

    if (!rows) {
      if (group.length)
        return fail('table.group needs table.rows: the column of nested rows (json_agg)');
      if (t.subtotal?.length)
        return fail(
          'table.subtotal needs a table with subtotals: set group and rows (the column of nested rows); for a simple table use total',
        );
    } else if (!group.length)
      return fail('table.rows needs table.group: at least one group column of the query row');

    const joined = texts.filter(Boolean).join('\n');
    const syntax = tagsError(joined) ?? (await checkPaths(joined));
    if (syntax) return fail(syntax);

    // Проверка и проба SQL — по одному вызову на инструмент.
    const c: DraftContext = { ...ctx, inject: memoInject(ctx.inject) };
    const table = rows ? await groupedTable(c, t, rows, group) : await simpleTable(c, t);
    if ('error' in table) return fail(table.error);
    const layout = buildSheetLayout({
      title,
      header,
      table,
      labels: sheetLabels(ctx.locale),
    });
    return {
      card: {
        type: 'sheet',
        templateId,
        templateName,
        key: t.key,
        layout,
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
      case 'get_sheet':
        return {
          result: {
            name: snapshot.name,
            usedRange: snapshot.usedRange,
            active: snapshot.active,
            cells: snapshot.cells,
            truncated: snapshot.truncated,
          },
        };
      default:
        return proposeSheet(parsed.data as SheetArgs);
    }
  }

  return { specs: SPECS, run };
}
