import { describe, expect, it, vi } from 'vitest';
import { createPathChecker } from './tag-paths';
import type { Inject } from './tools';

const TID = '0b6a4c1e-5f2d-4e8a-9c3b-7d1e2f3a4b5c';
const CHECK = `/api/templates/${TID}/queries/check`;
const draft = {
  queries: [
    { key: 'orders', mode: 'list' as const, sql: 'select name, total from orders' },
    { key: 'company', mode: 'single' as const, sql: 'select name, inn from company' },
  ],
  params: [
    {
      name: 'to',
      label: 'По',
      type: 'date' as const,
      required: false,
      defaultValue: null,
      options: null,
      sql: null,
      multiple: false,
    },
  ],
};
const columns: Record<string, string[]> = {
  'select name, total from orders': ['name', 'total'],
  'select name, inn from company': ['name', 'inn'],
};
const setup = (check?: { status: number; body: unknown }) => {
  const inject = vi.fn<Inject>(async (_m, url, payload) => {
    if (url !== CHECK) return { status: 404, body: {} };
    if (check) return check;
    const sql = (payload as { sql: string }).sql;
    return {
      status: 200,
      body: { ok: true, columns: columns[sql]!.map((name) => ({ name, type: 'text' })) },
    };
  });
  return { inject, check: createPathChecker({ inject, templateId: TID, draft }) };
};

describe('createPathChecker', () => {
  it('верные пути списка, одной строки и параметров — null', async () => {
    const { check, inject } = setup();
    expect(
      await check(
        '{d.orders[i].name} {d.orders[i].total:formatC(2)} {d.orders[i+1].name} {d.orders[].total:aggSum} {d.company.inn} {d.params.to}',
      ),
    ).toBeNull();
    // Проверка SQL — одна на запрос в пределах вызова.
    expect(inject).toHaveBeenCalledTimes(2);
  });

  it('список без индекса — ошибка с [i]', async () => {
    const e = await setup().check('{d.orders.name}');
    expect(e).toContain('d.orders[i]');
    expect(e).toContain('{d.orders.name}');
  });

  it('одна строка с индексом — ошибка', async () => {
    const e = await setup().check('{d.company[i].name}');
    expect(e).toContain('single-row');
    expect(e).toContain('d.company.name');
  });

  it('неизвестная колонка — ошибка с перечнем допустимых путей', async () => {
    const e = await setup().check('{d.orders[i].price}');
    expect(e).toContain('unknown column "price"');
    expect(e).toContain('d.orders[i].name');
    expect(e).toContain('d.orders[i].total');
    expect(e).toContain('d.company.inn');
    expect(e).toContain('d.params.to');
  });

  it('неизвестный запрос и параметр — ошибка', async () => {
    const { check } = setup();
    expect(await check('{d.params.from}')).toContain('unknown parameter "from"');
    expect(await check('{d.invoice.number}')).toContain('unknown query "invoice"');
  });

  it('теги c., t(), $, #alias и текст без тегов не сверяются', async () => {
    const { check, inject } = setup();
    expect(
      await check(
        "{c.now:formatD('L')} {$total} {t(Итого)} {#total = d.x[].y:aggSum} просто текст",
      ),
    ).toBeNull();
    expect(inject).not.toHaveBeenCalled();
  });

  it('проверка SQL не прошла или эндпоинт не ответил — колонки не сверяются', async () => {
    const failed = setup({ status: 200, body: { ok: false, error: 'нет таблицы' } });
    expect(await failed.check('{d.orders[i].anything} {d.company.whatever}')).toBeNull();
    const down = setup({ status: 502, body: { error: { code: 'X', message: 'm' } } });
    expect(await down.check('{d.orders[i].anything}')).toBeNull();
    // Ключ и режим проверяются и без колонок.
    expect(await failed.check('{d.orders.anything}')).toContain('d.orders[i]');
  });
});

describe('createPathChecker: вложенные строки (§53.2)', () => {
  const PROBE = `/api/templates/${TID}/queries/probe`;
  const groupsSql = 'select contractor, json_agg(json_build_object(...)) as rows from x group by 1';
  const groupsDraft = {
    queries: [{ key: 'groups', mode: 'list' as const, sql: groupsSql }],
    params: [],
  };
  const nestedSetup = (probe: unknown) => {
    const inject = vi.fn<Inject>(async (_m, url) => {
      if (url === CHECK)
        return {
          status: 200,
          body: {
            ok: true,
            columns: [
              { name: 'contractor', type: 'text' },
              { name: 'total', type: 'numeric' },
              { name: 'rows', type: 'json' },
            ],
          },
        };
      if (url === PROBE) return { status: 200, body: probe };
      return { status: 404, body: {} };
    });
    return {
      inject,
      check: createPathChecker({ inject, templateId: TID, draft: groupsDraft }),
    };
  };
  const sampled = {
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

  it('верные вложенные пути, подитог и конец вложенной строки — null; проба одна', async () => {
    const { check, inject } = nestedSetup(sampled);
    expect(
      await check(
        '{d.groups[i].contractor} {d.groups[i].rows[i].sum} {d.groups[i].rows[i].date:cellDate} {d.groups[i].rows[i+1]} {d.groups[i].rows[].sum:aggSum} {d.groups[].rows[].sum:aggSum}',
      ),
    ).toBeNull();
    expect(inject.mock.calls.filter((c) => c[1] === PROBE)).toHaveLength(1);
    expect(inject.mock.calls.filter((c) => c[1] === CHECK)).toHaveLength(1);
  });

  it('неизвестная вложенная колонка — ошибка с её именем', async () => {
    const e = await nestedSetup(sampled).check('{d.groups[i].rows[i].nope}');
    expect(e).toContain('nope');
    expect(e).toContain('{d.groups[i].rows[i].nope}');
  });

  it('колонка не вложенный массив при sampled — ошибка с json_agg', async () => {
    const e = await nestedSetup(sampled).check('{d.groups[i].total[i].sum}');
    expect(e).toContain('json_agg');
    expect(e).toContain('"total" of "groups"');
  });

  it('колонка вложенного пути проверяется по queries/check', async () => {
    const e = await nestedSetup(sampled).check('{d.groups[i].lines[i].sum}');
    expect(e).toContain('unknown column "lines" of "groups"');
  });

  it('sampled: false, проба ok: false или columns: [] — вложенная колонка принята', async () => {
    expect(
      await nestedSetup({ ok: true, sampled: false, nested: [] }).check(
        '{d.groups[i].rows[i].anything} {d.groups[i].total[i].x}',
      ),
    ).toBeNull();
    expect(
      await nestedSetup({ ok: false, error: 'timeout' }).check('{d.groups[i].rows[i].anything}'),
    ).toBeNull();
    expect(
      await nestedSetup({
        ok: true,
        sampled: true,
        nested: [{ column: 'rows', columns: [] }],
      }).check('{d.groups[i].rows[i].anything}'),
    ).toBeNull();
  });

  it('текст без вложенных сегментов не вызывает queries/probe', async () => {
    const { check, inject } = nestedSetup(sampled);
    expect(await check('{d.groups[i].contractor} {d.groups[i+1].contractor}')).toBeNull();
    expect(inject.mock.calls.some((c) => c[1] === PROBE)).toBe(false);
  });
});
