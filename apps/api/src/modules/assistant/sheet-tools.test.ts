import type { QueryProbe, SheetSnapshot } from '@carbone-reports/shared';
import { describe, expect, it, vi } from 'vitest';
import type { AppDeps } from '../../deps';
import { buildSheetLayout } from './sheet-layout';
import { createSheetTools, looksNumeric } from './sheet-tools';
import { createPathChecker } from './tag-paths';
import type { Inject } from './tools';

const TID = '0b6a4c1e-5f2d-4e8a-9c3b-7d1e2f3a4b5c';
const CHECK = `/api/templates/${TID}/queries/check`;
const PROBE = `/api/templates/${TID}/queries/probe`;
const draft = {
  queries: [
    { key: 'orders', mode: 'list' as const, sql: 'select date, sum, name from orders' },
    { key: 'groups', mode: 'list' as const, sql: 'select contractor, rows from g' },
    { key: 'company', mode: 'single' as const, sql: 'select name from company' },
    { key: 'totals', mode: 'single' as const, sql: 'select total, cnt, paid_on, info from totals' },
  ],
  params: [
    {
      name: 'from',
      label: 'С',
      type: 'date' as const,
      required: true,
      defaultValue: null,
      options: null,
      sql: null,
      multiple: false,
    },
  ],
};
const checks: Record<string, [string, string][]> = {
  'select date, sum, name from orders': [
    ['date', 'date'],
    ['sum', 'numeric'],
    ['name', 'text'],
  ],
  'select contractor, rows from g': [
    ['contractor', 'text'],
    ['rows', 'json'],
  ],
  'select name from company': [['name', 'text']],
  'select total, cnt, paid_on, info from totals': [
    ['total', 'numeric'],
    ['cnt', 'bigint'],
    ['paid_on', 'date'],
    ['info', 'json'],
  ],
};
const sampledProbe: QueryProbe = {
  ok: true,
  sampled: true,
  nested: [
    {
      column: 'rows',
      columns: [
        { name: 'date', type: 'date' },
        { name: 'sum', type: 'number' },
      ],
    },
  ],
};
const snapshot: SheetSnapshot = {
  name: 'Лист1',
  cells: [
    { ref: 'A1', text: 'Реестр' },
    { ref: 'B2', text: '1 234,50' },
  ],
  usedRange: 'A1:B2',
  active: 'B2',
  truncated: false,
};
const labels = { total: 'Итого', subtotal: 'Итого по группе' };

const setup = (snap: SheetSnapshot | null = snapshot, probe: QueryProbe = sampledProbe) => {
  const inject = vi.fn<Inject>(async (_m, url, payload) => {
    const sql = (payload as { sql: string }).sql;
    if (url === CHECK)
      return {
        status: 200,
        body: { ok: true, columns: (checks[sql] ?? []).map(([name, type]) => ({ name, type })) },
      };
    if (url === PROBE) return { status: 200, body: probe };
    return { status: 404, body: {} };
  });
  const tools = createSheetTools({
    inject,
    deps: {} as AppDeps,
    locale: 'ru',
    templateId: TID,
    templateName: 'Реестр',
    draft,
    snapshot: snap ?? undefined,
    checkPaths: createPathChecker({ inject, templateId: TID, draft }),
  });
  return { inject, tools };
};
const errorText = (r: unknown) => {
  expect(r).not.toHaveProperty('card');
  const s = JSON.stringify((r as { result: unknown }).result);
  expect(s).toContain('error');
  return s;
};
const simple = {
  key: 'orders',
  columns: [
    { column: 'date', label: 'Дата' },
    { column: 'sum', label: 'Сумма' },
  ],
  total: ['sum'],
};
const grouped = {
  key: 'groups',
  group: [{ column: 'contractor', label: 'Контрагент' }],
  rows: 'rows',
  columns: [
    { column: 'date', label: 'Дата' },
    { column: 'sum', label: 'Сумма' },
  ],
  subtotal: ['sum'],
  total: ['sum'],
};
const sheet = (table: object, extra: object = {}) => ({ table, explanation: 'Реестр', ...extra });

describe('createSheetTools', () => {
  it('нет снимка — все инструменты отвечают ошибкой', async () => {
    const { tools } = setup(null);
    for (const [name, args] of [
      ['get_sheet', {}],
      ['propose_sheet', sheet(simple)],
      ['propose_sheet_replacements', { items: [], explanation: 'x' }],
    ] as const) {
      expect(errorText(await tools.run(name, args))).toContain(
        'spreadsheet is not open — ask the author to open the Document tab',
      );
    }
  });

  it('get_sheet: снимок листа', async () => {
    expect(await setup().tools.run('get_sheet', {})).toEqual({
      result: {
        name: 'Лист1',
        usedRange: 'A1:B2',
        active: 'B2',
        cells: snapshot.cells,
        truncated: false,
      },
    });
  });

  it('неизвестный инструмент — ошибка модели', async () => {
    expect(await setup().tools.run('toString', {})).toEqual({
      result: { error: 'unknown tool: toString' },
    });
  });

  describe('propose_sheet', () => {
    it('простая таблица — карточка sheet с раскладкой сервера, модели { ok }', async () => {
      const { inject, tools } = setup();
      const r = await tools.run(
        'propose_sheet',
        sheet(simple, {
          title: 'Реестр заказов',
          header: [{ label: 'С:', value: '{d.params.from}' }],
        }),
      );
      expect(r).toEqual({
        card: {
          type: 'sheet',
          templateId: TID,
          templateName: 'Реестр',
          key: 'orders',
          layout: buildSheetLayout({
            title: 'Реестр заказов',
            header: [{ label: 'С:', value: '{d.params.from}' }],
            table: {
              key: 'orders',
              columns: [
                { column: 'date', label: 'Дата', kind: 'date' },
                { column: 'sum', label: 'Сумма', kind: 'decimal' },
              ],
              total: ['sum'],
            },
            labels,
          }),
          explanation: 'Реестр',
        },
        result: { ok: true },
      });
      // Проверка SQL таблицы — один вызов (кэш на инструмент), без пробы.
      const calls = inject.mock.calls.filter(
        ([, url, p]) => url === CHECK && (p as { sql: string }).sql === draft.queries[0]!.sql,
      );
      expect(calls).toHaveLength(1);
      expect(inject.mock.calls.some(([, url]) => url === PROBE)).toBe(false);
    });

    it('с подитогами — раскладка по приёму §53.2 (типы вложенных колонок по пробе)', async () => {
      const r = await setup().tools.run('propose_sheet', sheet(grouped));
      expect(r).toMatchObject({
        card: {
          type: 'sheet',
          key: 'groups',
          layout: buildSheetLayout({
            header: [],
            table: {
              key: 'groups',
              group: [{ column: 'contractor', label: 'Контрагент', kind: 'text' }],
              rows: 'rows',
              columns: [
                { column: 'date', label: 'Дата', kind: 'date' },
                { column: 'sum', label: 'Сумма', kind: 'decimal' },
              ],
              subtotal: ['sum'],
              total: ['sum'],
            },
            labels,
          }),
        },
        result: { ok: true },
      });
      const values = (
        r as { card: { layout: { cells: { value: string }[] } } }
      ).card.layout.cells.map((c) => c.value);
      expect(values).toContain('{d.groups[i].rows[i].date:cellDate}');
      expect(values).toContain('{d.groups[i].rows[].sum:aggSum:formatN(2)}');
      expect(values).toContain('Итого по группе');
    });

    it('ключ не-список или неизвестный, неизвестная колонка — ошибка как у listQueryError', async () => {
      const { tools } = setup();
      for (const key of ['company', 'nope']) {
        const t = errorText(await tools.run('propose_sheet', sheet({ ...simple, key })));
        expect(t).toContain('is not a list-mode query');
        expect(t).toContain('orders, groups');
      }
      const t = errorText(
        await tools.run(
          'propose_sheet',
          sheet({ ...simple, columns: [{ column: 'price', label: 'Цена' }], total: [] }),
        ),
      );
      expect(t).toContain('unknown columns price');
      expect(t).toContain('date, sum, name');
    });

    it('total по текстовой колонке — not a numeric column; не из колонок — ошибка', async () => {
      const { tools } = setup();
      const t = errorText(
        await tools.run(
          'propose_sheet',
          sheet({
            ...simple,
            columns: [...simple.columns, { column: 'name', label: 'Имя' }],
            total: ['name'],
          }),
        ),
      );
      expect(t).toContain('name\\" is not a numeric column');
      expect(
        errorText(await tools.run('propose_sheet', sheet({ ...simple, total: ['name'] }))),
      ).toContain('is not one of the table columns');
      expect(
        errorText(await tools.run('propose_sheet', sheet({ ...grouped, subtotal: ['date'] }))),
      ).toContain('date\\" is not a numeric column');
    });

    it('лимиты: header ≤ 20, columns 1..20, group 1..5', async () => {
      const { tools } = setup();
      const h = (n: number) => Array.from({ length: n }, () => ({ label: 'a', value: 'b' }));
      expect(
        errorText(await tools.run('propose_sheet', sheet(simple, { header: h(21) }))),
      ).toContain('invalid arguments');
      expect('card' in (await tools.run('propose_sheet', sheet(simple, { header: h(20) })))).toBe(
        true,
      );
      const cols = (n: number) => Array.from({ length: n }, () => ({ column: 'date', label: 'Д' }));
      for (const n of [0, 21])
        expect(
          errorText(
            await tools.run('propose_sheet', sheet({ ...simple, columns: cols(n), total: [] })),
          ),
          String(n),
        ).toContain('invalid arguments');
      expect(
        'card' in
          (await tools.run('propose_sheet', sheet({ ...simple, columns: cols(20), total: [] }))),
      ).toBe(true);
      const groups = (n: number) =>
        Array.from({ length: n }, () => ({ column: 'contractor', label: 'К' }));
      expect(
        errorText(await tools.run('propose_sheet', sheet({ ...grouped, group: groups(6) }))),
      ).toContain('invalid arguments');
      expect(
        'card' in (await tools.run('propose_sheet', sheet({ ...grouped, group: groups(5) }))),
      ).toBe(true);
      expect(
        errorText(await tools.run('propose_sheet', sheet({ ...grouped, group: [] }))),
      ).toContain('table.rows needs table.group');
    });

    it('rows без group, group или subtotal без rows — ошибка модели', async () => {
      const { tools } = setup();
      const { group: _, ...noGroup } = grouped;
      expect(errorText(await tools.run('propose_sheet', sheet(noGroup)))).toContain(
        'table.rows needs table.group',
      );
      expect(
        errorText(await tools.run('propose_sheet', sheet({ ...simple, subtotal: ['sum'] }))),
      ).toContain('table.subtotal needs');
      expect(
        errorText(
          await tools.run('propose_sheet', sheet({ ...simple, rows: '', group: grouped.group })),
        ),
      ).toContain('table.group needs table.rows');
      // Пустая строка rows — простая таблица.
      expect('card' in (await tools.run('propose_sheet', sheet({ ...simple, rows: '' })))).toBe(
        true,
      );
    });

    it('header.value с Handlebars — not Carbone syntax; неверный путь — invalid tag paths', async () => {
      const { tools } = setup();
      expect(
        errorText(
          await tools.run(
            'propose_sheet',
            sheet(simple, { header: [{ label: 'С', value: '{{params.from}}' }] }),
          ),
        ),
      ).toContain('not Carbone syntax');
      expect(
        errorText(
          await tools.run(
            'propose_sheet',
            sheet(simple, { header: [{ label: 'По', value: '{d.params.to}' }] }),
          ),
        ),
      ).toContain('invalid tag paths');
    });

    it('формулы в заголовке, подписях и значениях — formulas are not allowed (Review Focus 2)', async () => {
      const { tools } = setup();
      for (const args of [
        sheet(simple, { title: '=SUM(A1:A3)' }),
        sheet(simple, { header: [{ label: '=A1', value: 'x' }] }),
        sheet(simple, { header: [{ label: 'Сумма', value: ' =SUM(B2:B9)' }] }),
        sheet({ ...simple, columns: [{ column: 'sum', label: '=B2*2' }] }),
        sheet({ ...grouped, group: [{ column: 'contractor', label: '=A1' }] }),
      ])
        expect(errorText(await tools.run('propose_sheet', args)), JSON.stringify(args)).toContain(
          'formulas are not allowed',
        );
    });

    it('format/type недопустимые — invalid arguments; тип вложенной колонки — enum', async () => {
      const { tools } = setup();
      expect(
        errorText(
          await tools.run(
            'propose_sheet',
            sheet({ ...grouped, columns: [{ column: 'sum', label: 'С', type: 'money' }] }),
          ),
        ),
      ).toContain('invalid arguments');
      // Пустая строка и null — «тип не задан».
      for (const type of ['', null])
        expect(
          'card' in
            (await tools.run(
              'propose_sheet',
              sheet({ ...grouped, columns: [{ column: 'sum', label: 'С', type }] }),
            )),
        ).toBe(true);
    });

    it('rows — не вложенный массив при sampled: true — ошибка с json_agg', async () => {
      const { tools } = setup(snapshot, { ok: true, sampled: true, nested: [] });
      const t = errorText(await tools.run('propose_sheet', sheet(grouped)));
      expect(t).toContain('is not a nested array of rows');
      expect(t).toContain('json_agg');
    });

    it('неизвестная вложенная колонка при sampled: true — ошибка с колонками пробы', async () => {
      const t = errorText(
        await setup().tools.run(
          'propose_sheet',
          sheet({
            ...grouped,
            columns: [{ column: 'qty', label: 'Кол-во' }],
            subtotal: [],
            total: [],
          }),
        ),
      );
      expect(t).toContain('unknown columns qty');
      expect(t).toContain('date, sum');
    });

    it('проба sampled: false — карточка строится, subtotal принят как decimal, тип модели учтён (Review Focus 3)', async () => {
      const { tools } = setup(snapshot, { ok: true, sampled: false, nested: [] });
      const r = await tools.run(
        'propose_sheet',
        sheet({
          ...grouped,
          columns: [
            { column: 'date', label: 'Дата', type: 'date' },
            { column: 'sum', label: 'Сумма' },
            { column: 'qty', label: 'Кол-во', type: 'int' },
            { column: 'note', label: 'Примечание' },
          ],
        }),
      );
      expect(r).toMatchObject({ card: { type: 'sheet' }, result: { ok: true } });
      const values = (
        r as { card: { layout: { cells: { value: string }[] } } }
      ).card.layout.cells.map((c) => c.value);
      expect(values).toContain('{d.groups[i].rows[].sum:aggSum:formatN(2)}');
      expect(values).toContain('{d.groups[i].rows[i].sum:formatN(2)}');
      expect(values).toContain('{d.groups[i].rows[i].date:cellDate}');
      expect(values).toContain('{d.groups[i].rows[i].qty:formatN(0)}');
      expect(values).toContain('{d.groups[i].rows[i].note}');
      // Объявленный текстовый тип итога — не число.
      expect(
        errorText(
          await tools.run(
            'propose_sheet',
            sheet({ ...grouped, columns: [{ column: 'sum', label: 'С', type: 'text' }] }),
          ),
        ),
      ).toContain('sum\\" is not a numeric column');
    });

    it('проба не прошла — вложенные колонки не сверяются, тип модели учтён', async () => {
      const { tools } = setup(snapshot, { ok: false, error: 'boom' });
      const r = await tools.run(
        'propose_sheet',
        sheet({
          ...grouped,
          columns: [{ column: 'x', label: 'X', type: 'decimal' }],
          subtotal: ['x'],
          total: [],
        }),
      );
      expect(r).toMatchObject({ card: { type: 'sheet' } });
    });

    it('тип модели при sampled: true не меняет тип пробы', async () => {
      const r = await setup().tools.run(
        'propose_sheet',
        sheet({
          ...grouped,
          columns: [{ column: 'date', label: 'Дата', type: 'text' }],
          subtotal: [],
          total: [],
        }),
      );
      const values = (
        r as { card: { layout: { cells: { value: string }[] } } }
      ).card.layout.cells.map((c) => c.value);
      expect(values).toContain('{d.groups[i].rows[i].date:cellDate}');
    });

    it('группа по колонке вложенных строк или неизвестная группа — ошибка', async () => {
      const { tools } = setup();
      expect(
        errorText(
          await tools.run(
            'propose_sheet',
            sheet({ ...grouped, group: [{ column: 'rows', label: 'R' }] }),
          ),
        ),
      ).toContain('nested rows');
      expect(
        errorText(
          await tools.run(
            'propose_sheet',
            sheet({ ...grouped, group: [{ column: 'inn', label: 'ИНН' }] }),
          ),
        ),
      ).toContain('unknown columns inn');
    });
  });

  describe('propose_sheet_replacements', () => {
    const TOOL = 'propose_sheet_replacements';
    const c = (ref: string, text: string) => ({ ref, text });
    /** Заполненный реестр: шапка в 4-й строке, данные 5–7, итог 8. */
    const filled: SheetSnapshot = {
      name: 'Лист1',
      cells: [
        c('A1', 'Реестр заказов'),
        c('A2', 'Период: 01.01.2026 — 31.01.2026'),
        c('A4', 'Дата'),
        c('B4', 'Сумма'),
        c('C4', 'Клиент'),
        c('A5', '01.01.2026'),
        c('B5', '1 234,50'),
        c('C5', 'ООО Ромашка'),
        c('A6', '02.01.2026'),
        c('B6', '765,50'),
        c('C6', 'ООО Лютик'),
        c('A7', '03.01.2026'),
        c('B7', '1 000,00'),
        c('C7', 'ООО Ромашка'),
        c('A8', 'Итого'),
        c('B8', '3 000,00'),
        c('A9', 'Исполнитель: Иванов, тел. 11-11'),
      ],
      usedRange: 'A1:C9',
      active: 'A1',
      truncated: false,
    };
    const table = {
      headerRow: 4,
      firstDataRow: 5,
      lastDataRow: 7,
      key: 'orders',
      columns: ['date', 'sum', 'name'],
      totals: { row: 8, cells: [{ ref: 'B8', column: 'sum', agg: 'aggSum' }] },
    };
    const item = { ref: 'A2', find: '01.01.2026', tag: '{d.params.from}' };
    const args = (extra: object) => ({ items: [], explanation: 'Шаблон', ...extra });
    const run = (a: object, snap: SheetSnapshot = filled, probe?: QueryProbe) =>
      setup(snap, probe).tools.run(TOOL, a);

    it('простая таблица и замена — карточка sheetReplace (0-based), отпечаток, итог, сдвиг строк', async () => {
      const r = await run(
        args({
          items: [{ ...item, ref: 'a2', note: 'начало периода' }],
          table,
        }),
      );
      expect(r).toEqual({
        card: {
          type: 'sheetReplace',
          templateId: TID,
          templateName: 'Реестр',
          items: [
            { ref: 'A2', find: '01.01.2026', tag: '{d.params.from}', note: 'начало периода' },
          ],
          table: {
            key: 'orders',
            grouped: false,
            firstCol: 0,
            headerRow: 3,
            firstDataRow: 4,
            lastDataRow: 6,
            rowShift: -1,
            fingerprint: {
              header: ['Дата', 'Сумма', 'Клиент'],
              columns: 3,
              sample: ['01.01.2026', '1 234,50', 'ООО Ромашка'],
            },
            rows: [
              {
                styleFrom: 4,
                cells: [
                  '{d.orders[i].date:cellDate}',
                  '{d.orders[i].sum:formatN(2)}',
                  '{d.orders[i].name}',
                ],
              },
              { styleFrom: 4, cells: ['{d.orders[i+1].date}', '', ''] },
            ],
            totals: { row: 7, cells: [{ col: 1, tag: '{d.orders[].sum:aggSum:formatN(2)}' }] },
          },
          explanation: 'Шаблон',
        },
        result: { ok: true },
      });
    });

    it('отпечаток (F13): пустая ячейка внутри шапки — "", ширина от левой до правой непустой', async () => {
      const snap: SheetSnapshot = {
        ...filled,
        cells: filled.cells.filter((x) => x.ref !== 'B4' && x.ref !== 'B5'),
      };
      const r = (await run(args({ table: { ...table, totals: undefined } }), snap)) as {
        card: { table: { fingerprint: unknown; firstCol: number } };
      };
      expect(r.card.table.fingerprint).toEqual({
        header: ['Дата', '', 'Клиент'],
        columns: 3,
        sample: ['01.01.2026', '', 'ООО Ромашка'],
      });
      expect(r.card.table.firstCol).toBe(0);
    });

    it("шапка в C5:F5 при usedRange 'C3:AB40' — firstCol 2, headerRow 4", async () => {
      const snap: SheetSnapshot = {
        name: 'Лист1',
        cells: [
          c('C3', 'Реестр'),
          c('C5', 'Дата'),
          c('D5', 'Сумма'),
          c('E5', 'Клиент'),
          c('F5', 'Примечание'),
          c('C6', '01.01.2026'),
          c('D6', '10,00'),
          c('E6', 'ООО Ромашка'),
          c('F6', 'срочно'),
          c('AB40', 'конец'),
        ],
        usedRange: 'C3:AB40',
        active: 'C3',
        truncated: false,
      };
      const r = (await run(
        args({
          table: {
            headerRow: 5,
            firstDataRow: 6,
            lastDataRow: 6,
            key: 'orders',
            columns: ['date', 'sum', 'name', ''],
          },
        }),
        snap,
      )) as unknown as { card: { table: Record<string, unknown> } };
      expect(r.card.table).toMatchObject({
        firstCol: 2,
        headerRow: 4,
        firstDataRow: 5,
        lastDataRow: 5,
        rowShift: 1,
        fingerprint: {
          header: ['Дата', 'Сумма', 'Клиент', 'Примечание'],
          columns: 4,
          sample: ['01.01.2026', '10,00', 'ООО Ромашка', 'срочно'],
        },
        rows: [
          {
            styleFrom: 5,
            cells: [
              '{d.orders[i].date:cellDate}',
              '{d.orders[i].sum:formatN(2)}',
              '{d.orders[i].name}',
              null,
            ],
          },
          { styleFrom: 5, cells: ['{d.orders[i+1].date}', '', '', ''] },
        ],
        totals: null,
      });
    });

    it('только items — карточка с table: null; ничего — nothing to replace', async () => {
      const r = (await run(args({ items: [item] }))) as { card: { table: unknown } };
      expect(r.card.table).toBeNull();
      expect(errorText(await run(args({})))).toContain('nothing to replace');
      // Строгие модели шлют «пустые» объекты вместо отсутствующих.
      expect(
        errorText(await run(args({ table: { key: '', columns: [], headerRow: 0 } }))),
      ).toContain('nothing to replace');
    });

    it('find не из текста ячейки, пустая ячейка, неверный адрес — ошибка', async () => {
      expect(errorText(await run(args({ items: [{ ...item, find: '05.05.2026' }] })))).toContain(
        'not found in cell A2',
      );
      expect(errorText(await run(args({ items: [{ ...item, ref: 'B2' }] })))).toContain('B2');
      expect(errorText(await run(args({ items: [{ ...item, ref: 'A0' }] })))).toContain('A0');
    });

    it('весь отображаемый текст числовой ячейки — find принимается (Review Focus 1)', async () => {
      const r = await run(
        args({ items: [{ ref: 'B8', find: '3 000,00', tag: '{d.params.from}' }] }),
      );
      expect(r).toHaveProperty('card');
    });

    it('тег один во всей ячейке без форматтера — форматтер по типу колонки; иначе как есть (final #1)', async () => {
      const tagOf = async (it: { ref: string; find: string; tag: string }) => {
        const r = (await run(args({ items: [it] }))) as { card: { items: { tag: string }[] } };
        return r.card.items[0]!.tag;
      };
      // Вся ячейка: число, целое, дата — форматтер типа последним.
      expect(await tagOf({ ref: 'B8', find: '3 000,00', tag: '{d.totals.total}' })).toBe(
        '{d.totals.total:formatN(2)}',
      );
      expect(await tagOf({ ref: 'B8', find: '3 000,00', tag: ' { d.totals.cnt } ' })).toBe(
        '{d.totals.cnt:formatN(0)}',
      );
      expect(await tagOf({ ref: 'A5', find: '01.01.2026', tag: '{d.totals.paid_on}' })).toBe(
        '{d.totals.paid_on:cellDate}',
      );
      // Форматтер модели, часть ячейки, текст, неизвестный тип, параметр — без изменений.
      for (const it of [
        { ref: 'B8', find: '3 000,00', tag: '{d.totals.total:formatN(0)}' },
        { ref: 'A2', find: '01.01.2026', tag: '{d.totals.paid_on}' },
        { ref: 'A1', find: 'Реестр заказов', tag: '{d.company.name}' },
        { ref: 'B8', find: '3 000,00', tag: '{d.totals.info}' },
        { ref: 'A5', find: '01.01.2026', tag: '{d.params.from}' },
        { ref: 'B8', find: '3 000,00', tag: '{d.totals.total} ₽' },
      ])
        expect(await tagOf(it), it.tag).toBe(it.tag);
    });

    it('одна ячейка: разные непересекающиеся find — можно; тот же find дважды, пересечение, неоднозначный find — ошибка', async () => {
      const two = [item, { ref: 'A2', find: '31.01.2026', tag: '{d.params.from}' }];
      const r = (await run(args({ items: two }))) as { card: { items: unknown[] } };
      expect(r.card.items).toHaveLength(2);
      expect(
        errorText(await run(args({ items: [item, { ...item, tag: '{d.params.from}' }] }))),
      ).toContain('more than once');
      expect(
        errorText(
          await run(
            args({ items: [item, { ref: 'A2', find: '01.2026 —', tag: '{d.params.from}' }] }),
          ),
        ),
      ).toContain('overlap');
      expect(
        errorText(await run(args({ items: [{ ref: 'A9', find: '11', tag: '{d.params.from}' }] }))),
      ).toContain('2 times');
    });

    it('ref в строках данных таблицы (любая колонка) или в ячейке итога — ошибка', async () => {
      for (const ref of ['B6', 'D5'])
        expect(
          errorText(
            await run(args({ items: [{ ref, find: '765,50', tag: '{d.params.from}' }], table })),
          ),
          ref,
        ).toContain('data rows');
      expect(
        errorText(
          await run(
            args({ items: [{ ref: 'B8', find: '3 000,00', tag: '{d.params.from}' }], table }),
          ),
        ),
      ).toContain('totals cell');
    });

    it('tag: формула, не Carbone, неверный путь, без тега — ошибка', async () => {
      expect(errorText(await run(args({ items: [{ ...item, tag: '=A1' }] })))).toContain(
        'formulas are not allowed',
      );
      expect(errorText(await run(args({ items: [{ ...item, tag: '{{from}}' }] })))).toContain(
        'not Carbone syntax',
      );
      expect(errorText(await run(args({ items: [{ ...item, tag: '{d.params.to}' }] })))).toContain(
        'invalid tag paths',
      );
      expect(errorText(await run(args({ items: [{ ...item, tag: 'from' }] })))).toContain(
        'Carbone tag',
      );
    });

    it('columns длиной не по ширине шапки — ошибка с обеими длинами; ни одной колонки — ошибка', async () => {
      const t = errorText(await run(args({ table: { ...table, columns: ['date', 'sum'] } })));
      expect(t).toContain('3 cells');
      expect(t).toContain('got 2');
      expect(errorText(await run(args({ table: { ...table, columns: ['', '', ''] } })))).toContain(
        'at least one column',
      );
      expect(
        errorText(await run(args({ table: { ...table, columns: ['date', 'sum', 'inn'] } }))),
      ).toContain('unknown columns inn');
      expect(errorText(await run(args({ table: { ...table, key: 'company' } })))).toContain(
        'not a list-mode query',
      );
    });

    it('номера строк: порядок, пределы usedRange, пустая шапка — ошибка', async () => {
      for (const bad of [
        { headerRow: 5, firstDataRow: 5 },
        { firstDataRow: 7, lastDataRow: 6 },
        { lastDataRow: 12, totals: undefined },
        { headerRow: 3, firstDataRow: 4 },
      ])
        expect(
          errorText(await run(args({ table: { ...table, ...bad } }))),
          JSON.stringify(bad),
        ).toMatch(/headerRow|used range|empty/);
    });

    it('totals: текстовая колонка с aggSum — ошибка, с aggCount — formatN(0); строка, ширина, колонка', async () => {
      const totals = (cells: object[], row = 8) => ({
        table: { ...table, totals: { row, cells } },
      });
      expect(
        errorText(await run(args(totals([{ ref: 'C8', column: 'name', agg: 'aggSum' }])))),
      ).toContain('not a numeric column');
      const r = (await run(args(totals([{ ref: 'C8', column: 'name', agg: 'aggCount' }])))) as {
        card: { table: { totals: unknown } };
      };
      expect(r.card.table.totals).toEqual({
        row: 7,
        // B8 «3 000,00» не в totals.cells — число примера очищается.
        cells: [
          { col: 2, tag: '{d.orders[].name:aggCount:formatN(0)}' },
          { col: 1, tag: '' },
        ],
      });
      for (const [cells, row, text] of [
        [[{ ref: 'B9', column: 'sum', agg: 'aggSum' }], 8, 'row 8'],
        [[{ ref: 'D8', column: 'sum', agg: 'aggSum' }], 8, 'outside'],
        [[{ ref: 'B8', column: 'inn', agg: 'aggSum' }], 8, 'inn'],
        [[{ ref: 'B7', column: 'sum', agg: 'aggSum' }], 7, 'below'],
        [
          [
            { ref: 'B8', column: 'sum', agg: 'aggSum' },
            { ref: 'B8', column: 'sum', agg: 'aggMax' },
          ],
          8,
          'more than once',
        ],
      ] as const)
        expect(errorText(await run(args(totals([...cells], row)))), text).toContain(text);
      expect(
        errorText(await run(args(totals([{ ref: 'B8', column: 'sum', agg: 'aggMedian' }])))),
      ).toContain('invalid arguments');
      // Пустой список ячеек итога — итога нет.
      const none = (await run(args(totals([], 0)))) as { card: { table: { totals: unknown } } };
      expect(none.card.table.totals).toBeNull();
    });

    it('лимиты: items ≤ 100, columns ≤ 50', async () => {
      const snap: SheetSnapshot = {
        name: 'Лист1',
        cells: Array.from({ length: 101 }, (_, i) => c(`A${i + 1}`, `v${i + 1}`)),
        usedRange: 'A1:A101',
        active: 'A1',
        truncated: false,
      };
      const items = (n: number) =>
        Array.from({ length: n }, (_, i) => ({
          ref: `A${i + 1}`,
          find: `v${i + 1}`,
          tag: '{d.params.from}',
        }));
      expect(errorText(await run(args({ items: items(101) }), snap))).toContain(
        'invalid arguments',
      );
      expect(await run(args({ items: items(100) }), snap)).toHaveProperty('card');
      expect(
        errorText(await run(args({ table: { ...table, columns: Array(51).fill('') } }))),
      ).toContain('invalid arguments');
    });

    it('строка итога: числа примера вне totals.cells и не из items очищаются (tag ""), текст остаётся', async () => {
      const snap: SheetSnapshot = { ...filled, cells: [...filled.cells, c('C8', '3')] };
      const r = (await run(args({ table }), snap)) as {
        card: { table: { totals: unknown } };
      };
      expect(r.card.table.totals).toEqual({
        row: 7,
        cells: [
          { col: 1, tag: '{d.orders[].sum:aggSum:formatN(2)}' },
          { col: 2, tag: '' },
        ],
      });
      // Ячейку итога, занятую пунктом, не очищаем.
      const withItem = (await run(
        args({ table, items: [{ ref: 'C8', find: '3', tag: '{d.params.from}' }] }),
        snap,
      )) as { card: { table: { totals: { cells: unknown[] } } } };
      expect(withItem.card.table.totals.cells).toEqual([
        { col: 1, tag: '{d.orders[].sum:aggSum:formatN(2)}' },
      ]);
    });

    it('строка [i]: колонка "" над числом или датой примера — "", над текстом — null (постоянный текст)', async () => {
      const cells = async (columns: string[]) =>
        (
          (await run(args({ table: { ...table, columns, totals: undefined } }))) as {
            card: { table: { rows: { cells: unknown[] }[] } };
          }
        ).card.table.rows[0]!.cells;
      expect(await cells(['date', '', 'name'])).toEqual([
        '{d.orders[i].date:cellDate}',
        '',
        '{d.orders[i].name}',
      ]);
      expect(await cells(['', 'sum', ''])).toEqual(['', '{d.orders[i].sum:formatN(2)}', null]);
    });

    it('totals.cells[].column обрезается, как columns', async () => {
      const r = await run(
        args({
          table: {
            ...table,
            totals: { row: 8, cells: [{ ref: 'B8', column: ' sum ', agg: 'aggSum' }] },
          },
        }),
      );
      expect(r).toHaveProperty('card');
    });

    describe('grouped', () => {
      /** Пример с подитогами: шапка 1, группа 2, строки 3–4, подитог 5, группа 6–8, итог 9. */
      const gsnap: SheetSnapshot = {
        name: 'Лист1',
        cells: [
          c('A1', 'Дата'),
          c('B1', 'Сумма'),
          c('C1', 'Примечание'),
          c('A2', 'ООО Ромашка'),
          c('A3', '01.01.2026'),
          c('B3', '100,00'),
          c('C3', 'срочно'),
          c('A4', '02.01.2026'),
          c('B4', '200,00'),
          c('A5', 'Итого по группе'),
          c('B5', '300,00'),
          c('C5', '2'),
          c('A6', 'ООО Лютик'),
          c('A7', '03.01.2026'),
          c('B7', '50,00'),
          c('A8', 'Итого по группе'),
          c('B8', '50,00'),
          c('A9', 'Всего'),
          c('B9', '350,00'),
        ],
        usedRange: 'A1:C9',
        active: 'A1',
        truncated: false,
      };
      const gtable = {
        headerRow: 1,
        firstDataRow: 2,
        lastDataRow: 8,
        key: 'groups',
        columns: ['date', 'sum', ''],
        totals: { row: 9, cells: [{ ref: 'B9', column: 'sum', agg: 'aggSum' }] },
        grouped: {
          groupRow: 2,
          subtotalRow: 5,
          group: ['contractor', '', ''],
          rows: 'rows',
          subtotal: ['sum'],
        },
      };
      const grun = (t: object, probe?: QueryProbe) => run(args({ table: t }), gsnap, probe);

      it('5 строк со styleFrom по правилу, подитог с агрегатором, числа примера в подитоге очищены (F15)', async () => {
        const r = (await grun(gtable)) as { card: { table: unknown } };
        expect(r.card.table).toEqual({
          key: 'groups',
          grouped: true,
          firstCol: 0,
          headerRow: 0,
          firstDataRow: 1,
          lastDataRow: 7,
          rowShift: -2,
          fingerprint: {
            header: ['Дата', 'Сумма', 'Примечание'],
            columns: 3,
            sample: ['ООО Ромашка', '', ''],
          },
          rows: [
            { styleFrom: 1, cells: ['{d.groups[i].contractor}', null, null] },
            {
              styleFrom: 2,
              cells: [
                '{d.groups[i].rows[i].date:cellDate}',
                '{d.groups[i].rows[i].sum:formatN(2)}',
                null,
              ],
            },
            { styleFrom: 2, cells: ['{d.groups[i].rows[i+1].date}', '', ''] },
            { styleFrom: 4, cells: [null, '{d.groups[i].rows[].sum:aggSum:formatN(2)}', ''] },
            { styleFrom: 1, cells: ['{d.groups[i+1].contractor}', '', ''] },
          ],
          totals: { row: 8, cells: [{ col: 1, tag: '{d.groups[].rows[].sum:aggSum:formatN(2)}' }] },
        });
      });

      it('вложенная строка [i]: "" над числом примера — "", над текстом — null', async () => {
        const r = (await grun({
          ...gtable,
          columns: ['date', '', ''],
          totals: undefined,
          grouped: { ...gtable.grouped, subtotal: [] },
        })) as { card: { table: { rows: { cells: unknown[] }[] } } };
        expect(r.card.table.rows[1]!.cells).toEqual([
          '{d.groups[i].rows[i].date:cellDate}',
          '',
          null,
        ]);
      });

      it('grouped.columns (F7): равен table.columns — принят, иначе ошибка', async () => {
        expect(
          await grun({ ...gtable, grouped: { ...gtable.grouped, columns: ['date', 'sum', ''] } }),
        ).toHaveProperty('card');
        expect(
          errorText(
            await grun({ ...gtable, grouped: { ...gtable.grouped, columns: ['sum', 'date', ''] } }),
          ),
        ).toContain('grouped.columns');
      });

      it('subtotalRow === groupRow + 1, groupRow ≠ firstDataRow, subtotalRow ниже lastDataRow — ошибка', async () => {
        for (const g of [{ subtotalRow: 3 }, { groupRow: 3 }, { subtotalRow: 9 }])
          expect(
            errorText(await grun({ ...gtable, grouped: { ...gtable.grouped, ...g } })),
            JSON.stringify(g),
          ).toMatch(/groupRow|subtotalRow/);
      });

      it('group: длина, пустая, колонка вложенных строк; subtotal не из колонок или текстовый — ошибка', async () => {
        const g = (x: object) => grun({ ...gtable, grouped: { ...gtable.grouped, ...x } });
        expect(errorText(await g({ group: ['contractor'] }))).toContain('got 1');
        expect(errorText(await g({ group: ['', '', ''] }))).toContain('at least one group column');
        expect(errorText(await g({ group: ['rows', '', ''] }))).toContain('nested rows');
        expect(errorText(await g({ subtotal: ['inn'] }))).toContain('not one of the table columns');
        expect(errorText(await g({ subtotal: ['date'] }))).toContain('not a numeric column');
        expect(errorText(await g({ rows: '' }))).toContain('grouped.rows');
      });

      it('rows не вложенный массив при sampled: true — ошибка с json_agg; неизвестная вложенная колонка — ошибка', async () => {
        const probe: QueryProbe = { ok: true, sampled: true, nested: [] };
        expect(errorText(await grun(gtable, probe))).toContain('json_agg');
        expect(
          errorText(await grun({ ...gtable, columns: ['date', 'qty', ''], totals: undefined })),
        ).toContain('unknown columns qty');
      });

      it('проба sampled: false — колонки не сверяются, subtotal/total — decimal, дата — по примеру', async () => {
        const r = (await grun(gtable, { ok: true, sampled: false, nested: [] })) as {
          card: { table: { rows: { cells: unknown[] }[] } };
        };
        expect(r.card.table.rows[1]!.cells).toEqual([
          '{d.groups[i].rows[i].date:cellDate}',
          '{d.groups[i].rows[i].sum:formatN(2)}',
          null,
        ]);
      });

      it('проба без строк — типы вложенных колонок по строке примера: дата, дробное, целое, текст (final #3)', async () => {
        const snap: SheetSnapshot = {
          ...gsnap,
          cells: [
            ...gsnap.cells.filter((x) => x.ref !== 'C1' && x.ref !== 'C3'),
            c('C1', 'Кол-во'),
            c('C3', '5'),
            c('D1', 'Примечание'),
            c('D3', 'срочно'),
          ],
          usedRange: 'A1:D9',
        };
        const t = {
          ...gtable,
          columns: ['date', 'sum', 'qty', 'note'],
          totals: undefined,
          grouped: { ...gtable.grouped, group: ['contractor', '', '', ''], subtotal: [] },
        };
        const r = (await run(args({ table: t }), snap, {
          ok: true,
          sampled: false,
          nested: [],
        })) as { card: { table: { rows: { cells: unknown[] }[] } } };
        expect(r.card.table.rows[1]!.cells).toEqual([
          '{d.groups[i].rows[i].date:cellDate}',
          '{d.groups[i].rows[i].sum:formatN(2)}',
          '{d.groups[i].rows[i].qty:formatN(0)}',
          '{d.groups[i].rows[i].note}',
        ]);
        // Строки пробы есть — тип пробы, не примера.
        const probed = (await run(args({ table: t }), snap, {
          ok: true,
          sampled: true,
          nested: [
            {
              column: 'rows',
              columns: [
                { name: 'date', type: 'text' },
                { name: 'sum', type: 'number' },
                { name: 'qty', type: 'number' },
                { name: 'note', type: 'text' },
              ],
            },
          ],
        })) as { card: { table: { rows: { cells: unknown[] }[] } } };
        expect(probed.card.table.rows[1]!.cells[0]).toBe('{d.groups[i].rows[i].date}');
      });

      it('строгие модели: пустой grouped (rows "", group []) — простая таблица', async () => {
        const r = (await run(
          args({
            table: {
              ...table,
              grouped: { groupRow: 0, subtotalRow: 0, group: [], rows: '', subtotal: [] },
            },
          }),
        )) as { card: { table: { grouped: boolean } } };
        expect(r.card.table.grouped).toBe(false);
      });
    });
  });
});

describe('looksNumeric (F15)', () => {
  it('числа в отображаемом виде — да, подписи и даты с текстом — нет', () => {
    for (const t of ['2', '1 234,50', '-12.5', '(3 000)', '15 %', '100 ₽', '1\u00a0000,00', '−7'])
      expect(looksNumeric(t), t).toBe(true);
    for (const t of ['', 'Итого по группе', 'ООО 1', '12a', ',', '1,', 'n/a'])
      expect(looksNumeric(t), t).toBe(false);
  });
});
