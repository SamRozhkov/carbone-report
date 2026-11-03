import type { DocSnapshot } from '@carbone-reports/shared';
import { describe, expect, it, vi } from 'vitest';
import type { AppDeps } from '../../deps';
import { createDocumentTools } from './document-tools';
import { createPathChecker } from './tag-paths';
import type { Inject } from './tools';

const TID = '0b6a4c1e-5f2d-4e8a-9c3b-7d1e2f3a4b5c';
const CHECK = `/api/templates/${TID}/queries/check`;
const draft = {
  queries: [
    { key: 'items', mode: 'list' as const, sql: 'select name, qty, price from items' },
    { key: 'company', mode: 'single' as const, sql: 'select name, inn from company' },
  ],
  params: [],
};
const columns: Record<string, string[]> = {
  'select name, qty, price from items': ['name', 'qty', 'price'],
  'select name, inn from company': ['name', 'inn'],
};
const snapshot: DocSnapshot = {
  blocks: [
    { type: 'p', text: 'ООО Ромашка, ИНН 7701', area: 'header' },
    { type: 'p', text: 'Счёт № 15 для ООО Ромашка', area: 'body' },
    {
      type: 'table',
      area: 'body',
      rows: [
        ['Товар', 'Кол-во', 'Цена'],
        ['Стол', '2', '100'],
        ['Стул', '4', '50'],
      ],
    },
    { type: 'p', text: 'Поставщик: ООО Ромашка', area: 'footer' },
  ],
  truncated: false,
};

const setup = (snap: DocSnapshot | null = snapshot) => {
  const inject = vi.fn<Inject>(async (_m, url, payload) => {
    if (url !== CHECK) return { status: 404, body: {} };
    const sql = (payload as { sql: string }).sql;
    return {
      status: 200,
      body: { ok: true, columns: (columns[sql] ?? []).map((name) => ({ name, type: 'text' })) },
    };
  });
  return createDocumentTools({
    inject,
    deps: {} as AppDeps,
    locale: 'ru',
    templateId: TID,
    templateName: 'Счёт',
    draft,
    snapshot: snap ?? undefined,
    checkPaths: createPathChecker({ inject, templateId: TID, draft }),
  });
};
const errorText = (r: unknown) => {
  expect(r).not.toHaveProperty('card');
  const s = JSON.stringify((r as { result: unknown }).result);
  expect(s).toContain('error');
  return s;
};

describe('createDocumentTools', () => {
  it('нет снимка — все инструменты отвечают ошибкой', async () => {
    const tools = setup(null);
    for (const [name, args] of [
      ['get_document', {}],
      ['propose_document', { blocks: [{ type: 'p', text: 'x' }], explanation: '' }],
      [
        'propose_replacements',
        { items: [{ find: 'x', tag: '{d.company.name}' }], tables: [], explanation: '' },
      ],
    ] as const) {
      expect(errorText(await tools.run(name, args))).toContain(
        'document is not open — ask the author to open the Document tab',
      );
    }
  });

  it('get_document: блоки с номерами и областями', async () => {
    expect(await setup().run('get_document', {})).toEqual({
      result: {
        blocks: [
          { n: 0, type: 'p', area: 'header', text: 'ООО Ромашка, ИНН 7701' },
          { n: 1, type: 'p', area: 'body', text: 'Счёт № 15 для ООО Ромашка' },
          {
            n: 2,
            type: 'table',
            area: 'body',
            rows: (snapshot.blocks[2] as { rows: string[][] }).rows,
          },
          { n: 3, type: 'p', area: 'footer', text: 'Поставщик: ООО Ромашка' },
        ],
        truncated: false,
      },
    });
  });

  describe('propose_document', () => {
    const run = (blocks: unknown[]) =>
      setup().run('propose_document', { blocks, explanation: 'Счёт' });

    it('больше 60 блоков, уровень заголовка 4 — ошибка', async () => {
      errorText(await run(Array.from({ length: 61 }, () => ({ type: 'p', text: 'x' }))));
      errorText(await run([{ type: 'heading', level: 4, text: 'x' }]));
    });

    it('Handlebars — not Carbone syntax; неверный путь — ошибка сверки', async () => {
      expect(errorText(await run([{ type: 'p', text: '{#each d.items}' }]))).toContain(
        'not Carbone syntax',
      );
      expect(errorText(await run([{ type: 'p', text: '{d.company.phone}' }]))).toContain(
        'invalid tag paths',
      );
    });

    it('таблица по ключу не-списку — ошибка как у propose_table', async () => {
      expect(
        errorText(
          await run([
            { type: 'table', key: 'company', columns: [{ header: 'Имя', column: 'name' }] },
          ]),
        ),
      ).toContain('is not a list-mode query');
    });

    it('успех — карточка document, таблица развёрнута в строки, модели { ok }', async () => {
      const r = await run([
        { type: 'heading', level: 1, text: 'Счёт {d.company.name}' },
        { type: 'p', text: 'ИНН {d.company.inn}' },
        {
          type: 'table',
          key: 'items',
          columns: [
            { header: 'Товар', column: 'name' },
            { header: 'Цена', column: 'price', format: 'formatC(2)' },
          ],
        },
      ]);
      expect(r).toEqual({
        card: {
          type: 'document',
          templateId: TID,
          templateName: 'Счёт',
          blocks: [
            { type: 'heading', level: 1, text: 'Счёт {d.company.name}' },
            { type: 'p', text: 'ИНН {d.company.inn}' },
            {
              type: 'table',
              key: 'items',
              rows: [
                ['Товар', 'Цена'],
                ['{d.items[i].name}', '{d.items[i].price:formatC(2)}'],
                ['{d.items[i+1].name}', ''],
              ],
            },
          ],
          explanation: 'Счёт',
        },
        result: { ok: true },
      });
    });
  });

  describe('propose_replacements', () => {
    const table = { block: 2, headerRows: 1, key: 'items', columns: ['name', 'qty', 'price'] };
    const run = (items: unknown[], tables: unknown[] = []) =>
      setup().run('propose_replacements', { items, tables, explanation: 'Замены' });

    it('find нет в документе или дважды — ошибка', async () => {
      expect(errorText(await run([{ find: 'ООО Лютик', tag: '{d.company.name}' }]))).toContain(
        'not found',
      );
      expect(
        errorText(
          await run([
            { find: 'ООО Ромашка', tag: '{d.company.name}' },
            { find: 'ООО Ромашка', tag: '{d.company.inn}' },
          ]),
        ),
      ).toContain('more than once');
    });

    it('find только в строках данных преобразуемой таблицы — ошибка', async () => {
      expect(errorText(await run([{ find: 'Стол', tag: '{d.company.name}' }], [table]))).toContain(
        'data rows',
      );
      // Без таблицы в tables то же значение допустимо.
      expect(await run([{ find: 'Стол', tag: '{d.company.name}' }])).toHaveProperty('card');
    });

    it('block не таблица, число колонок не совпадает, неверный ключ — ошибка', async () => {
      expect(errorText(await run([], [{ ...table, block: 1 }]))).toContain('not a table');
      expect(errorText(await run([], [{ ...table, block: 9 }]))).toContain('not a table');
      expect(errorText(await run([], [{ ...table, columns: ['name', 'qty'] }]))).toContain(
        '3 cells',
      );
      expect(errorText(await run([], [{ ...table, headerRows: 3 }]))).toContain('headerRows');
      expect(errorText(await run([], [{ ...table, key: 'company' }]))).toContain(
        'is not a list-mode query',
      );
      expect(errorText(await run([], [{ ...table, columns: ['name', 'qty', 'cost'] }]))).toContain(
        'unknown columns cost',
      );
    });

    it('неверный путь или синтаксис в tag — ошибка', async () => {
      expect(errorText(await run([{ find: 'ИНН 7701', tag: '{d.company.kpp}' }]))).toContain(
        'invalid tag paths',
      );
      expect(errorText(await run([{ find: 'ИНН 7701', tag: '{{inn}}' }]))).toContain(
        'not Carbone syntax',
      );
      expect(errorText(await run([{ find: 'ИНН 7701', tag: 'ИНН' }]))).toContain('tag');
    });

    it('успех — карточка replace: вхождения, отпечаток, теги строки и служебная строка', async () => {
      const r = await run(
        [
          { find: 'ООО Ромашка', tag: '{d.company.name}', note: 'покупатель' },
          { find: '7701', tag: '{d.company.inn}' },
        ],
        [{ ...table, columns: [null, 'qty', 'price'] }],
      );
      expect(r).toEqual({
        card: {
          type: 'replace',
          templateId: TID,
          templateName: 'Счёт',
          items: [
            // Шапка, тело и подвал — три вхождения.
            { find: 'ООО Ромашка', tag: '{d.company.name}', note: 'покупатель', count: 3 },
            { find: '7701', tag: '{d.company.inn}', count: 1 },
          ],
          tables: [
            {
              block: 2,
              headerRows: 1,
              key: 'items',
              fingerprint: { header: [['Товар', 'Кол-во', 'Цена']], columns: 3 },
              rowTags: [null, '{d.items[i].qty}', '{d.items[i].price}'],
              serviceRow: ['', '{d.items[i+1].qty}', ''],
            },
          ],
          explanation: 'Замены',
        },
        result: { ok: true },
      });
    });
  });
});
