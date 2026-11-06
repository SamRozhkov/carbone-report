// Инструменты формирования в таблице (§53.2–53.3): снимок активного листа, лист по описанию
// и шаблон из заполненного листа. Только карточки: лист меняет автор кнопкой. Раскладку и теги
// строит сервер, модель задаёт ключ, колонки, группировку и адреса.
import {
  type EditorDraft,
  parseRange,
  parseRef,
  type QueryCheckColumn,
  type QueryProbeColumn,
  SheetDeclaredType,
  type SheetReplaceItem,
  type SheetReplaceRow,
  type SheetReplaceTable,
  type SheetSnapshot,
  toRef,
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
  aggTag,
  buildSheetLayout,
  columnKind,
  type GroupedTableSpec,
  nestedColumnKind,
  type SheetAgg,
  type SheetColumn,
  sheetLabels,
  type SimpleTableSpec,
  valueTag,
} from './sheet-layout';
import { createColumnLookup, memoInject, type PathChecker } from './tag-paths';
import type { AgentTools, ToolContext, ToolOutcome } from './tools';

const NOT_OPEN = 'spreadsheet is not open — ask the author to open the Document tab';
const NESTED_HINT =
  "build the nested rows in SQL with json_agg(json_build_object(...)), e.g. select contractor, json_agg(json_build_object('date', date, 'sum', sum) order by date) as rows from … group by contractor, and propose that query first";

const LIMITS = { header: 20, columns: 20, group: 5, items: 100, width: 50 } as const;
const SHEET_AGGS = [
  'aggSum',
  'aggCount',
  'aggAvg',
  'aggMin',
  'aggMax',
] as const satisfies readonly SheetAgg[];
/** Путь тега без форматтеров: d.<ключ>[индекс].<колонка>[индекс2].<вложенная колонка>. */
const SEG = String.raw`[^.[\]:\s,()'"|{}]+`;
const DATA_PATH = new RegExp(
  String.raw`^d\.(${SEG})(?:\[([^\]]*)\])?\.(${SEG})(?:\[([^\]]*)\]\.(${SEG}))?$`,
);
/** Предел номера строки листа (Excel). */
const MAX_ROW = 1_048_576;

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
  {
    type: 'function',
    function: {
      name: 'propose_sheet_replacements',
      description:
        'Turn the filled-in active sheet (an example report with real values) into a template (a card; the author applies chosen items with a button). Row numbers and A1 addresses are as in get_sheet. items: a value in a cell outside the data rows (title, header fields, notes) → Carbone tag, replaced only in that cell. table: the data rows of the example collapse into one repeated row of a list-mode query (the server builds the [i] and [i+1] rows and keeps the formatting of the example); totals: Carbone aggregators in the totals row; grouped: groups with subtotals, the query returns one row per group with the group columns and a nested array of rows (json_agg). If groups are not recognised, describe the table as simple and say so in explanation. Data rows are rebuilt as whole sheet rows: content beside the table in those rows (outside the header width) is lost — if there is any, warn the author in explanation.',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            description: `Value replacements (at most ${LIMITS.items}); an empty array if there are none`,
            items: {
              type: 'object',
              properties: {
                ref: str('Cell address from get_sheet, e.g. B2'),
                find: str(
                  'The cell text or an exact part of it that occurs in the cell once (include neighbouring text if needed); several items of one cell must not overlap',
                ),
                tag: str('Carbone tag, e.g. {d.params.from}'),
                note: str('Optional short note for the author'),
              },
              required: ['ref', 'find', 'tag'],
            },
          },
          table: {
            type: 'object',
            description: 'Optional: the data table of the example',
            properties: {
              headerRow: { type: 'integer', description: 'Row number of the column headers' },
              firstDataRow: { type: 'integer', description: 'Row number of the first data row' },
              lastDataRow: { type: 'integer', description: 'Row number of the last data row' },
              key: str('Key of a list-mode query of the template'),
              columns: {
                type: 'array',
                description:
                  'Query column for every cell of the header row, from its leftmost to its rightmost non-empty cell; an empty string means no tag: only constant text of the example stays in that cell (numbers and dates of the example are cleared). With grouped — columns of the nested rows',
                items: { type: 'string' },
              },
              totals: {
                type: 'object',
                description: 'Optional: the totals row of the example below the data rows',
                properties: {
                  row: { type: 'integer', description: 'Row number of the totals row' },
                  cells: {
                    type: 'array',
                    description: 'Cells of the totals row whose numbers become aggregators',
                    items: {
                      type: 'object',
                      properties: {
                        ref: str('Cell address in the totals row, e.g. D12'),
                        column: str('Column from columns'),
                        agg: {
                          type: 'string',
                          enum: SHEET_AGGS,
                          description:
                            'aggSum, aggAvg, aggMin, aggMax — numeric columns; aggCount — any',
                        },
                      },
                      required: ['ref', 'column', 'agg'],
                    },
                  },
                },
                required: ['row', 'cells'],
              },
              grouped: {
                type: 'object',
                description: 'Optional: only when the example has group rows and subtotal rows',
                properties: {
                  groupRow: {
                    type: 'integer',
                    description: 'Row number of the first group row (equals firstDataRow)',
                  },
                  subtotalRow: {
                    type: 'integer',
                    description: 'Row number of the subtotal row of the first group',
                  },
                  group: {
                    type: 'array',
                    description:
                      'Query column for every cell of the group row, same positions as columns; an empty string keeps the cell text',
                    items: { type: 'string' },
                  },
                  rows: str('The query column holding the nested array of rows (json_agg)'),
                  columns: {
                    type: 'array',
                    description: 'Optional: if given, must repeat table.columns',
                    items: { type: 'string' },
                  },
                  subtotal: {
                    type: 'array',
                    description: 'Numeric columns of the nested rows summed per group',
                    items: { type: 'string' },
                  },
                },
                required: ['groupRow', 'subtotalRow', 'group', 'rows', 'subtotal'],
              },
            },
            required: ['headerRow', 'firstDataRow', 'lastDataRow', 'key', 'columns'],
          },
          explanation: str('Short explanation'),
        },
        required: ['items', 'explanation'],
      },
    },
  },
];

/** Пустая строка и null от строгих моделей — «не задано». */
const unset = (v: unknown) => (v === '' || v === null ? undefined : v);
const Label = z.string().max(200);
const ColumnName = z.string().min(1).max(200);
const ColumnList = z.array(ColumnName).max(LIMITS.columns).nullish();
const RowNo = z.number().int().min(1).max(MAX_ROW);
/** Адрес ячейки: строгие модели пишут «b2» или «$B$2» — приводим к «B2». */
const CellRef = z
  .string()
  .max(20)
  .transform((r) => r.trim().replace(/\$/g, '').toUpperCase());
/** Колонка запроса по позиции ячейки; '' (и null) — ячейка без тега. */
const CellColumns = z
  .array(
    z
      .string()
      .max(200)
      .nullable()
      .transform((c) => c?.trim() ?? ''),
  )
  .max(LIMITS.width);
const blank = (v: unknown) =>
  v === undefined || v === null || v === '' || v === 0 || (Array.isArray(v) && !v.some(Boolean));
/**
 * Необязательный объект: null или объект с пустыми ключевыми полями (строгие модели шлют
 * «пустые» объекты вместо отсутствующих) — не задан.
 */
const absent = (keys: string[]) => (v: unknown) =>
  v === null ||
  (typeof v === 'object' &&
    !Array.isArray(v) &&
    keys.every((k) => blank((v as Record<string, unknown>)[k])))
    ? undefined
    : v;

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
  propose_sheet_replacements: z.object({
    items: z
      .array(
        z.object({
          ref: CellRef,
          find: z.string().min(1).max(500),
          tag: z.string().min(1).max(500),
          note: z.string().max(500).nullish(),
        }),
      )
      .max(LIMITS.items),
    table: z.preprocess(
      absent(['key', 'columns']),
      z
        .object({
          headerRow: RowNo,
          firstDataRow: RowNo,
          lastDataRow: RowNo,
          key: z.string().min(1).max(200),
          columns: CellColumns,
          totals: z.preprocess(
            absent(['cells']),
            z
              .object({
                row: RowNo,
                cells: z
                  .array(
                    z.object({
                      ref: CellRef,
                      column: z.string().trim().min(1).max(200),
                      agg: z.enum(SHEET_AGGS),
                    }),
                  )
                  .max(LIMITS.width),
              })
              .optional(),
          ),
          grouped: z.preprocess(
            absent(['group', 'rows']),
            z
              .object({
                groupRow: RowNo,
                subtotalRow: RowNo,
                group: CellColumns,
                rows: z.string().max(200),
                columns: CellColumns.nullish(),
                subtotal: ColumnList,
              })
              .optional(),
          ),
        })
        .optional(),
    ),
    explanation: z.string().max(1000),
  }),
};
type SheetArgs = z.infer<typeof ARGS.propose_sheet>;
type TableArgs = SheetArgs['table'];
type ReplaceArgs = z.infer<typeof ARGS.propose_sheet_replacements>;
type ReplaceTableArgs = NonNullable<ReplaceArgs['table']>;

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

/**
 * Колонки вложенных строк по пробе (§53.2): известные колонки (null — неизвестны, путь
 * принимается) или ошибка для модели — колонка не массив строк, неизвестная вложенная колонка,
 * имя, негодное для пути тега.
 */
async function nestedKnown(
  c: DraftContext,
  key: string,
  rows: string,
  names: string[],
): Promise<{ known: QueryProbeColumn[] | null } | { error: string }> {
  const nested = await nestedColumns(c, key, rows);
  if (nested.sampled && nested.columns === null)
    return { error: `"${rows}" of "${key}" is not a nested array of rows; ${NESTED_HINT}` };
  // Пустой массив в пробной строке — колонки неизвестны, как без строк.
  const known = nested.sampled && nested.columns?.length ? nested.columns : null;
  if (known) {
    const unknown = names.filter((n) => !known.some((k) => k.name === n));
    if (unknown.length)
      return {
        error: `unknown columns ${unknown.join(', ')} of the nested rows "${key}[i].${rows}" (nested rows have: ${known.map((k) => k.name).join(', ')})`,
      };
  }
  const bad = names.find((n) => BAD_PATH.test(n));
  return bad ? { error: pathError(bad) } : { known };
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

/**
 * Отображаемый текст числа («1 234,50», «-12.5», «(3 000)», «15 %», «100 ₽»): такие ячейки
 * в строке подитога примера вне колонок subtotal очищаются (F15), чтобы числа примера не попали
 * в отчёт.
 */
export function looksNumeric(text: string): boolean {
  const t = text
    .replace(/[\s\u00a0\u202f]/g, '')
    .replace(/(?:₽|руб\.?|р\.|\$|€|%)$/i, '')
    .replace(/^[-+−(]/, '')
    .replace(/\)$/, '');
  return /^\d[\d.,]*$/.test(t) && /\d$/.test(t);
}

/** Отображаемая дата (с временем или без): «01.01.2026», «2026-01-31 10:00». */
export function looksDate(text: string): boolean {
  return /^\d{1,4}[./-]\d{1,2}[./-]\d{1,4}(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?$/.test(text.trim());
}

/**
 * Тип значения по отображаемому тексту примера (final #3): дата, целое (без разделителя дробной
 * части), дробное; прочее — неизвестно (undefined, тип по умолчанию).
 */
export function exampleType(text: string): SheetDeclaredType | undefined {
  if (looksDate(text)) return 'date';
  if (looksNumeric(text)) return /[.,]/.test(text) ? 'decimal' : 'int';
  return undefined;
}

/**
 * Ячейка повторяемой строки без тега: число или дата примера очищаются (''), иначе это
 * постоянный текст, он остаётся (null).
 */
const keepConstant = (text: string) => (looksNumeric(text) || looksDate(text) ? '' : null);

/** Непересекающиеся вхождения подстроки. */
const occurrences = (text: string, find: string) => text.split(find).length - 1;

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
    const nested = await nestedKnown(
      c,
      t.key,
      rows,
      t.columns.map((x) => x.column),
    );
    if ('error' in nested) return nested;
    const { known } = nested;

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

  const REPLACE = 'propose_sheet_replacements';

  /**
   * Таблица примера (§53.3 сценарий 3): ширина — от левой до правой непустой ячейки headerRow,
   * строки данных сворачиваются в строку [i] и служебную [i+1] (с подитогами — группа, [i], [i+1],
   * подитог, служебная группы). Номера в ответе — 0-based.
   */
  async function replaceTable(
    c: DraftContext,
    snapshot: SheetSnapshot,
    textAt: (row: number, col: number) => string,
    t: ReplaceTableArgs,
    itemRefs: Set<string>,
  ): Promise<SheetReplaceTable | { error: string }> {
    const fail = (error: string) => ({ error });
    const range = parseRange(snapshot.usedRange)!;
    const [h, f, l] = [t.headerRow - 1, t.firstDataRow - 1, t.lastDataRow - 1];
    if (!(h < f && f <= l))
      return fail(
        `table rows: need headerRow < firstDataRow <= lastDataRow, got ${t.headerRow}, ${t.firstDataRow}, ${t.lastDataRow}`,
      );
    if (h < range.top || l > range.bottom)
      return fail(
        `table rows ${t.headerRow}..${t.lastDataRow} are outside the used range ${snapshot.usedRange} (rows ${range.top + 1}..${range.bottom + 1})`,
      );
    const headerCols = snapshot.cells
      .map((x) => ({ p: parseRef(x.ref), text: x.text }))
      .filter((x) => x.p?.row === h && x.text.trim() !== '')
      .map((x) => x.p!.col);
    if (!headerCols.length)
      return fail(
        `header row ${t.headerRow} is empty in the sheet; take row numbers from get_sheet`,
      );
    const firstCol = Math.min(...headerCols);
    const lastCol = Math.max(...headerCols);
    const width = lastCol - firstCol + 1;
    const span = `${toRef(h, firstCol)}:${toRef(h, lastCol)}`;
    if (t.columns.length !== width)
      return fail(
        `columns: the header row ${t.headerRow} spans ${span} (${width} cells), got ${t.columns.length} columns; give a column (or an empty string) for every cell`,
      );
    const named = t.columns.filter(Boolean);
    if (!named.length) return fail('columns: at least one column must be set');
    const first = t.columns.findIndex(Boolean);
    const rowTexts = (row: number) =>
      Array.from({ length: width }, (_, i) => textAt(row, firstCol + i));

    // Ячейки итога: проверяются до построения — нужны типы агрегируемых колонок.
    const totals = t.totals;
    const tr = totals ? totals.row - 1 : -1;
    if (totals) {
      if (tr <= l)
        return fail(`totals.row ${totals.row} must be below lastDataRow ${t.lastDataRow}`);
      if (tr > range.bottom)
        return fail(`totals.row ${totals.row} is outside the used range ${snapshot.usedRange}`);
      const seen = new Set<string>();
      for (const x of totals.cells) {
        const p = parseRef(x.ref);
        if (!p) return fail(`totals: "${x.ref}" is not a cell address like D12`);
        if (p.row !== tr) return fail(`totals: ${x.ref} is not in row ${totals.row}`);
        if (p.col < firstCol || p.col > lastCol)
          return fail(`totals: ${x.ref} is outside the table columns ${span}`);
        if (seen.has(x.ref)) return fail(`totals: ${x.ref} is listed more than once`);
        seen.add(x.ref);
        if (!named.includes(x.column))
          return fail(
            `totals: "${x.column}" is not one of the table columns (${named.join(', ')})`,
          );
      }
    }
    // Агрегаты, кроме aggCount, — числа: такая колонка без типа пробы считается дробной.
    const summed = new Set(
      (totals?.cells ?? []).filter((x) => x.agg !== 'aggCount').map((x) => x.column),
    );

    let rows: SheetReplaceRow[];
    let kindOf: (column: string) => SheetColumn['kind'];
    let totalPath: (column: string) => string;
    const g = t.grouped;
    if (!g) {
      const error = await listQueryError(c, REPLACE, t.key, named);
      if (error) return fail(error);
      const types = (await queryColumns(c, t.key)) ?? [];
      kindOf = (col) => columnKind(types.find((y) => y.name === col)?.type ?? '');
      const tag = (col: string) => valueTag(`d.${t.key}[i].${col}`, kindOf(col));
      rows = [
        {
          styleFrom: f,
          cells: t.columns.map((col, i) =>
            col ? tag(col) : keepConstant(textAt(f, firstCol + i)),
          ),
        },
        {
          styleFrom: f,
          cells: t.columns.map((_, i) => (i === first ? `{d.${t.key}[i+1].${named[0]}}` : '')),
        },
      ];
      totalPath = (col) => `d.${t.key}[].${col}`;
    } else {
      const [gr, sr] = [g.groupRow - 1, g.subtotalRow - 1];
      if (gr !== f)
        return fail(
          `grouped.groupRow ${g.groupRow} must equal table.firstDataRow ${t.firstDataRow}`,
        );
      if (!(gr + 1 < sr && sr <= l))
        return fail(
          `grouped.subtotalRow ${g.subtotalRow} must be below the first data row of the group (row ${g.groupRow + 1}) and not below lastDataRow ${t.lastDataRow}`,
        );
      if (g.columns?.length && g.columns.join('\n') !== t.columns.join('\n'))
        return fail(
          'grouped.columns must repeat table.columns (the columns of the nested rows) or be omitted',
        );
      if (g.group.length !== width)
        return fail(
          `grouped.group: the table ${span} is ${width} cells wide, got ${g.group.length}; give a group column (or an empty string) for every cell`,
        );
      const group = g.group.filter(Boolean);
      if (!group.length) return fail('grouped.group: at least one group column must be set');
      const nestedName = g.rows.trim();
      if (!nestedName)
        return fail('grouped.rows: the query column holding the nested array of rows (json_agg)');
      const error = await listQueryError(c, REPLACE, t.key, [...group, nestedName]);
      if (error) return fail(error);
      if (group.includes(nestedName))
        return fail(
          `grouped.group: "${nestedName}" is the column of nested rows, not a group column`,
        );
      const nested = await nestedKnown(c, t.key, nestedName, named);
      if ('error' in nested) return nested;
      const { known } = nested;
      const subtotal = uniq(g.subtotal);
      const types = (await queryColumns(c, t.key)) ?? [];
      // Проба без строк: тип вложенной колонки — по ячейке первой вложенной строки примера.
      const example = (col: string) =>
        exampleType(textAt(gr + 1, firstCol + t.columns.indexOf(col)));
      kindOf = (col) => {
        const aggregated = subtotal.includes(col) || summed.has(col);
        const declared = example(col);
        return nestedColumnKind({
          sampled: !!known,
          probed: known?.find((k) => k.name === col),
          // Агрегируемая колонка с нечисловым примером остаётся дробной.
          declared:
            aggregated && (declared === 'date' || declared === 'text') ? undefined : declared,
          aggregated,
        });
      };
      const bad = aggregatesError(
        'subtotal',
        subtotal,
        named.map((col) => ({ column: col, label: col, kind: kindOf(col) })),
      );
      if (bad) return fail(bad);
      const groupKind = (col: string) => columnKind(types.find((y) => y.name === col)?.type ?? '');
      const nestedPath = (index: string, col: string) =>
        `d.${t.key}[i].${nestedName}[${index}].${col}`;
      const firstGroup = g.group.findIndex(Boolean);
      const subtotalTexts = rowTexts(sr);
      rows = [
        {
          styleFrom: gr,
          cells: g.group.map((col, i) =>
            col
              ? valueTag(`d.${t.key}[i].${col}`, groupKind(col))
              : keepConstant(textAt(gr, firstCol + i)),
          ),
        },
        {
          styleFrom: gr + 1,
          cells: t.columns.map((col, i) =>
            col
              ? valueTag(nestedPath('i', col), kindOf(col))
              : keepConstant(textAt(gr + 1, firstCol + i)),
          ),
        },
        {
          styleFrom: gr + 1,
          cells: t.columns.map((_, i) => (i === first ? `{${nestedPath('i+1', named[0]!)}}` : '')),
        },
        {
          // Подитог: агрегаторы; прочие числа примера очищаются, подписи остаются (F15).
          styleFrom: sr,
          cells: t.columns.map((col, i) =>
            col && subtotal.includes(col)
              ? aggTag(nestedPath('', col), 'aggSum', kindOf(col))
              : looksNumeric(subtotalTexts[i]!)
                ? ''
                : null,
          ),
        },
        {
          styleFrom: gr,
          cells: g.group.map((_, i) => (i === firstGroup ? `{d.${t.key}[i+1].${group[0]}}` : '')),
        },
      ];
      totalPath = (col) => `d.${t.key}[].${nestedName}[].${col}`;
    }

    let totalCells: { col: number; tag: string }[] = [];
    if (totals) {
      for (const x of totals.cells) {
        const kind = kindOf(x.column);
        if (x.agg !== 'aggCount' && !isNumeric(kind))
          return fail(
            `totals: "${x.column}" is not a numeric column (type ${kind}); ${x.agg} needs numbers, aggCount counts rows`,
          );
      }
      totalCells = totals.cells.map((x) => ({
        col: parseRef(x.ref)!.col,
        tag: aggTag(totalPath(x.column), x.agg, kindOf(x.column)),
      }));
      // Прочие числа примера в строке итога (не агрегаторы и не пункты) очищаются: tag ''.
      for (let col = firstCol; col <= lastCol; col++) {
        const ref = toRef(tr, col);
        if (totalCells.some((x) => x.col === col) || itemRefs.has(ref)) continue;
        if (looksNumeric(textAt(tr, col))) totalCells.push({ col, tag: '' });
      }
    }
    return {
      key: t.key,
      grouped: !!g,
      firstCol,
      headerRow: h,
      firstDataRow: f,
      lastDataRow: l,
      rowShift: rows.length - (l - f + 1),
      fingerprint: { header: rowTexts(h), columns: width, sample: rowTexts(f) },
      rows,
      totals: totals ? { row: tr, cells: totalCells } : null,
    };
  }

  /**
   * Тип колонки по пути тега (final #1): колонка запроса — по проверке SQL, колонка вложенных
   * строк — по пробе со строками; параметр, конец строки [i+1] или неизвестная колонка — null.
   */
  async function pathKind(c: DraftContext, path: string): Promise<SheetColumn['kind'] | null> {
    const m = DATA_PATH.exec(path);
    if (!m) return null;
    const [, key, index, column, subIndex, sub] = m as unknown as [
      string,
      string,
      string | undefined,
      string,
      string | undefined,
      string | undefined,
    ];
    if (key === 'params' || index?.includes('+') || subIndex?.includes('+')) return null;
    if (subIndex === undefined) {
      const type = (await queryColumns(c, key))?.find((x) => x.name === column)?.type;
      return type === undefined ? null : columnKind(type);
    }
    const nested = await nestedColumns(c, key, column);
    const type = nested.sampled ? nested.columns?.find((x) => x.name === sub)?.type : undefined;
    return type === undefined ? null : columnKind(type);
  }

  async function proposeSheetReplacements(
    snapshot: SheetSnapshot,
    a: ReplaceArgs,
  ): Promise<ToolOutcome> {
    if (!a.items.length && !a.table) return { result: { error: 'nothing to replace' } };
    const fail = (error: string) => ({ result: { error } });
    // Тег, начинающийся с «=», станет формулой Excel.
    const formula = formulaError(a.items.map((it) => it.tag));
    if (formula) return fail(formula);
    const texts = new Map(snapshot.cells.map((x) => [x.ref, x.text]));
    const textAt = (row: number, col: number) => texts.get(toRef(row, col)) ?? '';

    // Проверка и проба SQL — по одному вызову на инструмент.
    const c: DraftContext = { ...ctx, inject: memoInject(ctx.inject) };
    let table: SheetReplaceTable | null = null;
    if (a.table) {
      const itemRefs = new Set(a.items.map((it) => it.ref));
      const built = await replaceTable(c, snapshot, textAt, a.table, itemRefs);
      if ('error' in built) return fail(built.error);
      table = built;
    }
    const totalRefs = new Set(a.table?.totals?.cells.map((x) => x.ref) ?? []);

    // Пункты: ячейка снимка вне строк данных и итогов, find — одно вхождение в её тексте,
    // пункты одной ячейки не пересекаются (веб заменяет каждый на своём месте).
    const problems: string[] = [];
    const items: SheetReplaceItem[] = [];
    const spans = new Map<string, { find: string; from: number; to: number }[]>();
    for (const it of a.items) {
      const p = parseRef(it.ref);
      if (!p) {
        problems.push(`"${it.ref}" is not a cell address like B2`);
        continue;
      }
      if (table && p.row >= table.firstDataRow && p.row <= table.lastDataRow) {
        problems.push(
          `${it.ref} is in the data rows ${table.firstDataRow + 1}..${table.lastDataRow + 1} of the table, which are rebuilt; data values become tags through table.columns`,
        );
        continue;
      }
      if (totalRefs.has(it.ref)) {
        problems.push(`${it.ref} is a totals cell of the table; it gets an aggregator`);
        continue;
      }
      const text = texts.get(it.ref);
      if (text === undefined) {
        problems.push(`${it.ref} is empty in the sheet; take addresses from get_sheet`);
        continue;
      }
      const n = occurrences(text, it.find);
      if (!n) {
        problems.push(
          `"${it.find}" not found in cell ${it.ref} (cell text: ${JSON.stringify(text)}); copy the exact text`,
        );
        continue;
      }
      if (n > 1) {
        problems.push(
          `"${it.find}" occurs ${n} times in cell ${it.ref}; include neighbouring text so it occurs once`,
        );
        continue;
      }
      if (!/\{[^{}]+\}/.test(it.tag)) {
        problems.push(`tag of "${it.find}" must be a Carbone tag like {d.params.from}`);
        continue;
      }
      const from = text.indexOf(it.find);
      const to = from + it.find.length;
      const cell = spans.get(it.ref) ?? [];
      const same = cell.find((x) => x.find === it.find);
      const overlap = cell.find((x) => from < x.to && x.from < to);
      if (same) problems.push(`"${it.find}" in cell ${it.ref} is listed more than once`);
      else if (overlap)
        problems.push(`"${it.find}" and "${overlap.find}" overlap in cell ${it.ref}`);
      else {
        cell.push({ find: it.find, from, to });
        spans.set(it.ref, cell);
        items.push({
          ref: it.ref,
          find: it.find,
          tag: it.tag,
          ...(it.note ? { note: it.note } : {}),
        });
      }
    }
    if (problems.length) return fail(problems.join('; '));
    const tags = a.items.map((it) => it.tag).join('\n');
    const error = tagsError(tags) ?? (await checkPaths(tags));
    if (error) return fail(error);
    // Тег один во всей ячейке без форматтера (final #1): число и дата остаются числом и датой —
    // форматтер типа колонки последним; тип неизвестен или текст — тег как есть.
    for (const it of items) {
      if (it.find.trim() !== texts.get(it.ref)!.trim()) continue;
      const path = /^\{\s*(d\.[^{}:\s]+)\s*\}$/.exec(it.tag.trim())?.[1];
      const kind = path ? await pathKind(c, path) : null;
      if (path && kind && kind !== 'text') it.tag = valueTag(path, kind);
    }
    return {
      card: {
        type: 'sheetReplace',
        templateId,
        templateName,
        items,
        table,
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
      case 'propose_sheet':
        return proposeSheet(parsed.data as SheetArgs);
      default:
        return proposeSheetReplacements(snapshot, parsed.data as ReplaceArgs);
    }
  }

  return { specs: SPECS, run };
}
