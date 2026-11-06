import { createRequire } from 'node:module';
import type { SheetLayout } from '@carbone-reports/shared';
import { describe, expect, it } from 'vitest';
import {
  aggTag,
  buildSheetLayout,
  columnKind,
  nestedColumnKind,
  tableLayout,
  valueTag,
  type GroupedTableSpec,
  type SimpleTableSpec,
} from './sheet-layout';

const labels = { total: 'Итого', subtotal: 'Итого по группе' };

/** Раскладка → сетка текстов (пустые ячейки — ''). */
const grid = (l: SheetLayout) => {
  const g = Array.from({ length: l.rows }, () => Array<string>(l.cols).fill(''));
  for (const c of l.cells) g[c.row]![c.col] = c.value;
  return g;
};
/** Стиль строки: стиль её ячеек (все одинаковые), пустая строка — null. */
const rowStyles = (l: SheetLayout) =>
  Array.from({ length: l.rows }, (_, r) => {
    const s = [...new Set(l.cells.filter((c) => c.row === r).map((c) => c.style))];
    return s.length ? s.join('|') : null;
  });

const orders: SimpleTableSpec = {
  key: 'orders',
  columns: [
    { column: 'date', label: 'Дата', kind: 'date' },
    { column: 'sum', label: 'Сумма', kind: 'decimal' },
  ],
  total: ['sum'],
};

// данные Task 2 (packages/carbone test.sheet-forming.js): группы контрагентов с вложенными строками
const groups: GroupedTableSpec = {
  key: 'groups',
  group: [{ column: 'contractor', label: 'Контрагент', kind: 'text' }],
  rows: 'rows',
  columns: [
    { column: 'date', label: 'Дата', kind: 'date' },
    { column: 'sum', label: 'Сумма', kind: 'decimal' },
  ],
  subtotal: ['sum'],
  total: ['sum'],
};

describe('columnKind', () => {
  it.each([
    ['integer', 'integer'],
    ['bigint', 'integer'],
    ['numeric(12,2)', 'decimal'],
    ['double precision', 'decimal'],
    ['money', 'decimal'],
    ['number', 'decimal'],
    ['timestamp with time zone', 'date'],
    ['date', 'date'],
    ['text', 'text'],
    ['jsonb', 'text'],
    ['boolean', 'text'],
  ])('%s → %s', (type, kind) => expect(columnKind(type)).toBe(kind));
});

describe('nestedColumnKind (F8)', () => {
  it('проба со строкой — тип пробы', () => {
    expect(
      nestedColumnKind({
        sampled: true,
        probed: { name: 'd', type: 'date' },
        declared: 'text',
        aggregated: false,
      }),
    ).toBe('date');
  });
  it('без строки — тип модели, int → integer', () => {
    expect(nestedColumnKind({ sampled: false, declared: 'int', aggregated: false })).toBe(
      'integer',
    );
    expect(nestedColumnKind({ sampled: false, declared: 'date', aggregated: true })).toBe('date');
  });
  it('ни пробы, ни типа — decimal для итогов, иначе text', () => {
    expect(nestedColumnKind({ sampled: false, aggregated: true })).toBe('decimal');
    expect(nestedColumnKind({ sampled: false, aggregated: false })).toBe('text');
  });
});

describe('valueTag / aggTag', () => {
  it('форматтер по типу, у текста — формат модели', () => {
    expect(valueTag('d.o[i].n', 'integer')).toBe('{d.o[i].n:formatN(0)}');
    expect(valueTag('d.o[i].s', 'decimal')).toBe('{d.o[i].s:formatN(2)}');
    expect(valueTag('d.o[i].d', 'date')).toBe('{d.o[i].d:cellDate}');
    expect(valueTag('d.o[i].t', 'text')).toBe('{d.o[i].t}');
    expect(valueTag('d.o[i].t', 'text', "ifEmpty('-')")).toBe("{d.o[i].t:ifEmpty('-')}");
    // у чисел формат модели отбрасывается — форматтер типа последний
    expect(valueTag('d.o[i].s', 'decimal', 'formatC(2)')).toBe('{d.o[i].s:formatN(2)}');
  });
  it('знаки агрегатора: aggCount 0, aggAvg 2, прочие по типу', () => {
    expect(aggTag('d.o[].s', 'aggSum', 'decimal')).toBe('{d.o[].s:aggSum:formatN(2)}');
    expect(aggTag('d.o[].n', 'aggSum', 'integer')).toBe('{d.o[].n:aggSum:formatN(0)}');
    expect(aggTag('d.o[].n', 'aggMax', 'integer')).toBe('{d.o[].n:aggMax:formatN(0)}');
    expect(aggTag('d.o[].s', 'aggMin', 'decimal')).toBe('{d.o[].s:aggMin:formatN(2)}');
    expect(aggTag('d.o[].s', 'aggCount', 'decimal')).toBe('{d.o[].s:aggCount:formatN(0)}');
    expect(aggTag('d.o[].n', 'aggAvg', 'integer')).toBe('{d.o[].n:aggAvg:formatN(2)}');
    expect(aggTag('d.o[].t', 'aggCount', 'text')).toBe('{d.o[].t:aggCount:formatN(0)}');
  });
});

describe('buildSheetLayout: простая таблица', () => {
  it('без заголовка — 4 строки: шапка, [i], [i+1], итог', () => {
    const l = buildSheetLayout({ header: [], table: orders, labels });
    expect(l.rows).toBe(4);
    expect(l.cols).toBe(2);
    expect(grid(l)).toEqual([
      ['Дата', 'Сумма'],
      ['{d.orders[i].date:cellDate}', '{d.orders[i].sum:formatN(2)}'],
      ['{d.orders[i+1].date}', ''],
      ['Итого', '{d.orders[].sum:aggSum:formatN(2)}'],
    ]);
    expect(rowStyles(l)).toEqual(['header', 'data', 'plain', 'total']);
    const at = (row: number, col: number) => l.cells.find((c) => c.row === row && c.col === col)!;
    expect([at(1, 0).kind, at(1, 1).kind]).toEqual(['date', 'decimal']);
    expect([at(3, 0).kind, at(3, 1).kind]).toEqual(['text', 'decimal']); // F14: подпись — текст
    expect(at(0, 0).kind).toBe('text');
    // служебная строка — только ячейка с тегом
    expect(l.cells.filter((c) => c.row === 2)).toHaveLength(1);
  });

  it('без total — без строки итога; tableLayout — та же таблица', () => {
    const l = tableLayout({ ...orders, total: [] }, labels);
    expect(l.rows).toBe(3);
    expect(grid(l)[2]).toEqual(['{d.orders[i+1].date}', '']);
    expect(tableLayout(orders, labels)).toEqual(
      buildSheetLayout({ header: [], table: orders, labels }),
    );
  });

  it('total по первой колонке — «Итого» не ставится; целые — formatN(0)', () => {
    const l = tableLayout(
      {
        key: 'orders',
        columns: [
          { column: 'qty', label: 'Кол-во', kind: 'integer' },
          { column: 'name', label: 'Товар', kind: 'text' },
        ],
        total: ['qty'],
      },
      labels,
    );
    expect(grid(l)[3]).toEqual(['{d.orders[].qty:aggSum:formatN(0)}', '']);
    expect(l.cells.find((c) => c.row === 3 && c.col === 0)!.kind).toBe('integer');
    expect(l.cells.filter((c) => c.row === 3).map((c) => c.style)).toEqual(['total', 'total']);
  });

  it('формат текстовой колонки сохраняется в теге и ячейке (F1)', () => {
    const l = tableLayout(
      {
        key: 'orders',
        columns: [
          { column: 'name', label: 'Товар', kind: 'text', format: "ifEmpty('-')" },
          { column: 'sum', label: 'Сумма', kind: 'decimal' },
        ],
        total: [],
      },
      labels,
    );
    const cell = l.cells.find((c) => c.row === 1 && c.col === 0)!;
    expect(cell).toMatchObject({
      value: "{d.orders[i].name:ifEmpty('-')}",
      format: "ifEmpty('-')",
    });
    expect(l.cells.find((c) => c.row === 1 && c.col === 1)!.format).toBeUndefined();
  });

  it('заголовок и две строки шапки — таблица со строки 4, подписи в A', () => {
    const l = buildSheetLayout({
      title: 'Реестр заказов',
      header: [
        { label: 'Период:', value: '{d.params.from} — {d.params.to}' },
        { label: 'Организация:', value: '{d.company.name}' },
      ],
      table: orders,
      labels,
    });
    const g = grid(l);
    expect(l.rows).toBe(8);
    expect(g.slice(0, 4)).toEqual([
      ['Реестр заказов', ''],
      ['Период:', '{d.params.from} — {d.params.to}'],
      ['Организация:', '{d.company.name}'],
      ['', ''],
    ]);
    expect(g[4]).toEqual(['Дата', 'Сумма']);
    expect(g[5]![0]).toBe('{d.orders[i].date:cellDate}');
    expect(rowStyles(l).slice(0, 5)).toEqual([
      'title',
      'label|plain',
      'label|plain',
      null,
      'header',
    ]);
    // A/B шапки не уже подписей и значений
    expect(l.widths[0]).toBeGreaterThanOrEqual('Организация:'.length);
    expect(l.widths[1]).toBeGreaterThanOrEqual('{d.params.from} — {d.params.to}'.length);
  });

  it('шапка над таблицей из одной колонки — cols ≥ 2', () => {
    const l = buildSheetLayout({
      header: [{ label: 'Дата отчёта', value: '{d.params.on}' }],
      table: { key: 'o', columns: [{ column: 'n', label: 'N', kind: 'text' }], total: [] },
      labels,
    });
    expect(l.cols).toBe(2);
    expect(l.widths).toHaveLength(2);
  });

  it('ширины: clamp(max(label+2, W[kind]), 8, 60)', () => {
    const l = tableLayout(
      {
        key: 'o',
        columns: [
          { column: 'a', label: 'N', kind: 'integer' },
          { column: 'b', label: 'Сумма', kind: 'decimal' },
          { column: 'c', label: 'Д', kind: 'date' },
          { column: 'd', label: 'Очень длинная подпись колонки '.repeat(4), kind: 'text' },
          { column: 'e', label: 'Наименование контрагента', kind: 'text' },
        ],
        total: [],
      },
      labels,
    );
    expect(l.widths).toEqual([10, 14, 12, 60, 26]);
    for (const w of l.widths) expect(w).toBeGreaterThanOrEqual(8);
  });
});

describe('buildSheetLayout: подитоги по группам', () => {
  const l = buildSheetLayout({ header: [], table: groups, labels });

  it('строки по приёму §53.2 — те же теги, что в Task 2', () => {
    expect(grid(l)).toEqual([
      ['Контрагент', ''],
      ['Дата', 'Сумма'],
      ['{d.groups[i].contractor}', ''],
      ['{d.groups[i].rows[i].date:cellDate}', '{d.groups[i].rows[i].sum:formatN(2)}'],
      ['{d.groups[i].rows[i+1].date}', ''],
      ['Итого по группе', '{d.groups[i].rows[].sum:aggSum:formatN(2)}'],
      ['{d.groups[i+1].contractor}', ''],
      ['Итого', '{d.groups[].rows[].sum:aggSum:formatN(2)}'],
    ]);
    expect(rowStyles(l)).toEqual([
      'header',
      'header',
      'group',
      'data',
      'plain',
      'subtotal',
      'plain',
      'total',
    ]);
    // строка группы — на всю ширину таблицы, подпись подитога — текст (F14)
    expect(l.cells.filter((c) => c.row === 2)).toHaveLength(2);
    expect(l.cells.find((c) => c.row === 5 && c.col === 0)!.kind).toBe('text');
  });

  it('без subtotal/total — только группа и вложенные строки', () => {
    const g = grid(
      buildSheetLayout({ header: [], table: { ...groups, subtotal: [], total: [] }, labels }),
    );
    expect(g).toHaveLength(6);
    expect(g[5]![0]).toBe('{d.groups[i+1].contractor}');
  });

  it('ширина колонки — по самой широкой из группы и вложенных', () => {
    // A: «Контрагент» (text, 20) и «Дата» (date, 12) → 20; B: «Сумма» → 14
    expect(l.widths).toEqual([20, 14]);
  });
});

// Рендер раскладки движком (как в packages/carbone test.sheet-forming.js): теги раскладки дают
// числа и даты в готовом XLSX, итог и подитоги считает Carbone.
describe('раскладка рендерится Carbone (XLSX)', () => {
  const require = createRequire(import.meta.url);
  const lib = require('../../../../../packages/carbone/test/golden-lib.js') as {
    GROUPS: unknown;
    LIST: unknown;
    renderXlsx: (
      rows: string[][],
      data: unknown,
    ) => Promise<{ rows: { t: string | null; v: string | null }[][] }>;
  };
  const values = (rows: { t: string | null; v: string | null }[][]) =>
    rows.map((r) => r.filter((c) => c.v !== null && c.v !== '').map((c) => `${c.t}:${c.v}`));

  it('простая таблица с итогом', async () => {
    const l = tableLayout({ ...orders, key: 'list' }, labels);
    const { rows } = await lib.renderXlsx(grid(l), { list: lib.LIST });
    expect(values(rows)).toEqual([
      ['s:Дата', 's:Сумма'],
      ['n:46027', 'n:100.5'],
      ['n:46029', 'n:50'],
      ['n:46054', 'n:10.25'],
      ['s:Итого', 'n:160.75'],
    ]);
  });

  it('подитоги по группам и общий итог', async () => {
    const l = buildSheetLayout({ header: [], table: groups, labels });
    const { rows } = await lib.renderXlsx(grid(l), { groups: lib.GROUPS });
    expect(values(rows)).toEqual([
      ['s:Контрагент'],
      ['s:Дата', 's:Сумма'],
      ['s:Альфа'],
      ['n:46027', 'n:100.5'],
      ['n:46029', 'n:50'],
      ['s:Итого по группе', 'n:150.5'],
      ['s:Бета'],
      ['n:46054', 'n:10.25'],
      ['s:Итого по группе', 'n:10.25'],
      ['s:Итого', 'n:160.75'],
    ]);
  });
});
