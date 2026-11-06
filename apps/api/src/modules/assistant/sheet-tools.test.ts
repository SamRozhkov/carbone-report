import type { QueryProbe, SheetSnapshot } from '@carbone-reports/shared';
import { describe, expect, it, vi } from 'vitest';
import type { AppDeps } from '../../deps';
import { buildSheetLayout } from './sheet-layout';
import { createSheetTools } from './sheet-tools';
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
});
