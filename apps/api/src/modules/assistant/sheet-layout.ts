// Построитель раскладки листа (§53.1–53.3): описание таблицы → ячейки с тегами Carbone, типами,
// стилями и ширинами колонок. Теги ставит сервер: форматтер типа — последний и единственный в ячейке,
// итоги и подитоги — агрегаторы Carbone (приём закреплён тестом packages/carbone test.sheet-forming.js),
// формул Excel нет.
import type {
  QueryProbeColumn,
  SheetCellKind,
  SheetCellStyle,
  SheetDeclaredType,
  SheetLayout,
  SheetLayoutCell,
} from '@carbone-reports/shared';
import type { Locale } from '@carbone-reports/shared/i18n';
import { createTranslator } from '@carbone-reports/shared/i18n/server';

export type SheetAgg = 'aggSum' | 'aggCount' | 'aggAvg' | 'aggMin' | 'aggMax';

/** Колонка таблицы листа; format — цепочка форматтеров модели, только у kind 'text'. */
export interface SheetColumn {
  column: string;
  label: string;
  kind: SheetCellKind;
  format?: string;
}

export interface SimpleTableSpec {
  key: string;
  columns: SheetColumn[];
  total: string[];
}

export interface GroupedTableSpec {
  key: string;
  group: SheetColumn[];
  rows: string;
  columns: SheetColumn[];
  subtotal: string[];
  total: string[];
}

export interface SheetLabels {
  total: string;
  subtotal: string;
}

export interface SheetSpec {
  title?: string;
  header: { label: string; value: string }[];
  table: SimpleTableSpec | GroupedTableSpec;
  labels: SheetLabels;
}

/** Тип колонки SQL (queries/check) или пробы (queries/probe) → тип ячейки листа. */
export function columnKind(type: string): SheetCellKind {
  const t = type.trim().toLowerCase();
  if (/^(smallint|integer|bigint|int[248]?)$/.test(t)) return 'integer';
  if (/^(numeric|decimal|real|double precision|money|number|float[48]?)\b/.test(t))
    return 'decimal';
  if (/^(date|timestamp)\b/.test(t)) return 'date';
  return 'text';
}

/** Тип, объявленный моделью для вложенной колонки (F8): словарь 'int' → 'integer'. */
export function declaredKind(type: SheetDeclaredType): SheetCellKind {
  return type === 'int' ? 'integer' : type;
}

/**
 * Тип вложенной колонки (F8): проба вернула строку — тип пробы; строки не было (sampled: false) —
 * тип, объявленный моделью; ни того ни другого — decimal для колонок итогов, иначе text.
 */
export function nestedColumnKind(opts: {
  sampled: boolean;
  probed?: QueryProbeColumn;
  declared?: SheetDeclaredType;
  aggregated: boolean;
}): SheetCellKind {
  if (opts.sampled && opts.probed) return columnKind(opts.probed.type);
  if (!opts.sampled && opts.declared) return declaredKind(opts.declared);
  return opts.aggregated ? 'decimal' : 'text';
}

const TYPE_FORMATTER: Record<SheetCellKind, string> = {
  text: '',
  integer: ':formatN(0)',
  decimal: ':formatN(2)',
  date: ':cellDate',
};

/** Тег значения: форматтер типа; у текста — формат модели, если задан. */
export function valueTag(path: string, kind: SheetCellKind, format?: string): string {
  if (kind === 'text') return format ? `{${path}:${format}}` : `{${path}}`;
  return `{${path}${TYPE_FORMATTER[kind]}}`;
}

/** Число знаков агрегатора: aggCount — 0, aggAvg — 2, прочие — 0 для integer, иначе 2. */
const aggDigits = (agg: SheetAgg, kind: SheetCellKind) =>
  agg === 'aggCount' ? 0 : agg === 'aggAvg' ? 2 : kind === 'integer' ? 0 : 2;

/** Тег агрегатора с форматтером числа последним. */
export function aggTag(path: string, agg: SheetAgg, kind: SheetCellKind): string {
  return `{${path}:${agg}:formatN(${aggDigits(agg, kind)})}`;
}

/** Ширины по типу (символы) и пределы. */
const KIND_WIDTH: Record<SheetCellKind, number> = { text: 20, integer: 10, decimal: 14, date: 12 };
const MIN_WIDTH = 8;
const MAX_WIDTH = 60;
const clamp = (n: number) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, n));
const columnWidth = (c: SheetColumn) => clamp(Math.max(c.label.length + 2, KIND_WIDTH[c.kind]));

/** Содержимое ячейки без координат и стиля. */
type CellValue = Omit<SheetLayoutCell, 'row' | 'col' | 'style'>;

/** Сборщик строк раскладки: строки добавляются сверху вниз, ширина — по самой широкой строке. */
class Grid {
  rows = 0;
  cells: SheetLayoutCell[] = [];

  /** Строка из ячеек; стиль style — у всех ячеек 0..width-1 (пустые стилизованные — тоже). */
  row(values: (CellValue | null)[], style: SheetCellStyle, width: number) {
    const row = this.rows++;
    for (let col = 0; col < width; col++) {
      const v = values[col] ?? { value: '', kind: 'text' as const };
      this.cells.push({ row, col, style, ...v });
    }
  }

  /** Строка без оформления: только непустые ячейки. */
  plain(values: (CellValue | null)[]) {
    const row = this.rows++;
    values.forEach((v, col) => {
      if (v && v.value !== '') this.cells.push({ row, col, style: 'plain', ...v });
    });
  }

  /** Строка над таблицей: текст в A со стилем style, значение (если есть) — в B без оформления. */
  cell(value: string, style: SheetCellStyle, b?: string) {
    const row = this.rows++;
    this.cells.push({ row, col: 0, value, kind: 'text', style });
    if (b) this.cells.push({ row, col: 1, value: b, kind: 'text', style: 'plain' });
  }

  blank() {
    this.rows++;
  }
}

const text = (value: string) => ({ value, kind: 'text' as const });
const data = (path: string, c: SheetColumn) => ({
  value: valueTag(path, c.kind, c.format),
  kind: c.kind,
  ...(c.kind === 'text' && c.format ? { format: c.format } : {}),
});
/** Ячейка агрегатора: тип — по числу знаков (aggCount — целое). */
const agg = (path: string, c: SheetColumn) => ({
  value: aggTag(path, 'aggSum', c.kind),
  kind: aggDigits('aggSum', c.kind) === 0 ? ('integer' as const) : ('decimal' as const),
});

/** Строка итогов: агрегаторы в колонках list, подпись в A, если первая колонка не итоговая. */
function totalRow(
  grid: Grid,
  columns: SheetColumn[],
  list: string[],
  path: (c: SheetColumn) => string,
  label: string,
  style: SheetCellStyle,
  width: number,
) {
  const values: (CellValue | null)[] = columns.map((c) =>
    list.includes(c.column) ? agg(path(c), c) : null,
  );
  if (!values[0]) values[0] = text(label);
  grid.row(values, style, width);
}

function simpleTable(grid: Grid, t: SimpleTableSpec, labels: SheetLabels, width: number) {
  const first = t.columns[0]!;
  grid.row(
    t.columns.map((c) => text(c.label)),
    'header',
    width,
  );
  grid.row(
    t.columns.map((c) => data(`d.${t.key}[i].${c.column}`, c)),
    'data',
    width,
  );
  grid.plain([text(`{d.${t.key}[i+1].${first.column}}`)]);
  if (t.total.length)
    totalRow(
      grid,
      t.columns,
      t.total,
      (c) => `d.${t.key}[].${c.column}`,
      labels.total,
      'total',
      width,
    );
}

function groupedTable(grid: Grid, t: GroupedTableSpec, labels: SheetLabels, width: number) {
  const nested = (index: string, c: SheetColumn) => `d.${t.key}[i].${t.rows}[${index}].${c.column}`;
  if (t.group.length)
    grid.row(
      t.group.map((c) => text(c.label)),
      'header',
      width,
    );
  grid.row(
    t.columns.map((c) => text(c.label)),
    'header',
    width,
  );
  grid.row(
    t.group.map((c) => data(`d.${t.key}[i].${c.column}`, c)),
    'group',
    width,
  );
  grid.row(
    t.columns.map((c) => data(nested('i', c), c)),
    'data',
    width,
  );
  grid.plain([text(`{${nested('i+1', t.columns[0]!)}}`)]);
  if (t.subtotal.length)
    totalRow(grid, t.columns, t.subtotal, (c) => nested('', c), labels.subtotal, 'subtotal', width);
  grid.plain([text(`{d.${t.key}[i+1].${t.group[0]!.column}}`)]);
  if (t.total.length)
    totalRow(
      grid,
      t.columns,
      t.total,
      (c) => `d.${t.key}[].${t.rows}[].${c.column}`,
      labels.total,
      'total',
      width,
    );
}

const isGrouped = (t: SimpleTableSpec | GroupedTableSpec): t is GroupedTableSpec => 'rows' in t;

/** Ширина колонки i — по самой широкой колонке таблицы в этой позиции (группа и вложенные строки). */
function tableWidths(t: SimpleTableSpec | GroupedTableSpec, width: number): number[] {
  const sets = isGrouped(t) ? [t.group, t.columns] : [t.columns];
  return Array.from({ length: width }, (_, i) =>
    Math.max(MIN_WIDTH, ...sets.map((s) => (s[i] ? columnWidth(s[i]) : MIN_WIDTH))),
  );
}

/**
 * Лист по описанию (§53.3, сценарий 2): заголовок в A, строки шапки «подпись — значение» в A/B,
 * пустая строка, затем таблица — простая или с подитогами по группам. Колонки и группы уже
 * проверены вызывающим (ключ, режим, типы, непустые columns и group для таблицы с подитогами).
 */
export function buildSheetLayout(spec: SheetSpec): SheetLayout {
  const { table, header, labels } = spec;
  const grid = new Grid();
  if (spec.title) grid.cell(spec.title, 'title');
  for (const h of header) grid.cell(h.label, 'label', h.value);
  if (spec.title || header.length) grid.blank();

  const tableCols = isGrouped(table)
    ? Math.max(table.group.length, table.columns.length)
    : table.columns.length;
  if (isGrouped(table)) groupedTable(grid, table, labels, tableCols);
  else simpleTable(grid, table, labels, tableCols);

  const cols = header.length ? Math.max(2, tableCols) : tableCols;
  const widths = tableWidths(table, cols);
  if (header.length) {
    // Колонки A/B шапки — не уже подписей и значений.
    const longest = (xs: string[]) => Math.max(0, ...xs.map((x) => x.length));
    widths[0] = Math.min(MAX_WIDTH, Math.max(widths[0]!, longest(header.map((h) => h.label))));
    widths[1] = Math.min(MAX_WIDTH, Math.max(widths[1]!, longest(header.map((h) => h.value))));
  }
  return { rows: grid.rows, cols, cells: grid.cells, widths };
}

/** Только таблица (карточка table в листе, §53.3 сценарий 1): шапка, [i], [i+1], итог. */
export function tableLayout(table: SimpleTableSpec, labels: SheetLabels): SheetLayout {
  return buildSheetLayout({ header: [], table, labels });
}

/** Подписи итогов на языке пользователя (§53.3). */
export function sheetLabels(locale: Locale): SheetLabels {
  const t = createTranslator(locale);
  return { total: t('common:assistant.sheetTotal'), subtotal: t('common:assistant.sheetSubtotal') };
}

/** Тексты раскладки сеткой rows × cols (пустые ячейки — ''): строки карточки table в листе. */
export function layoutTexts(layout: SheetLayout): string[][] {
  const g = Array.from({ length: layout.rows }, () => Array<string>(layout.cols).fill(''));
  for (const c of layout.cells) g[c.row]![c.col] = c.value;
  return g;
}
