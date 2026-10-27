import { describe, expect, it, vi } from 'vitest';
import type { AppDeps } from '../../deps';
import { checkParamDefaults } from '../queries/params';
import { createAuthorTools } from './author-tools';
import { mergeTools, type AgentTools, type Inject } from './tools';

const TID = '0b6a4c1e-5f2d-4e8a-9c3b-7d1e2f3a4b5c';
const draft = {
  queries: [
    {
      key: 'items',
      mode: 'list' as const,
      sql: 'select name, qty from items where invoice_id = :invoiceId',
    },
  ],
  params: [
    {
      name: 'invoiceId',
      label: 'Счёт',
      type: 'number' as const,
      required: true,
      defaultValue: null,
      options: null,
      sql: null,
      multiple: false,
    },
  ],
};
const okCheck = { ok: true, columns: [{ name: 'id', type: 'integer' }] };
const setup = (responses: Record<string, { status: number; body: unknown }> = {}) => {
  const inject = vi.fn<Inject>(async (_m, url) => responses[url] ?? { status: 200, body: okCheck });
  return {
    inject,
    tools: createAuthorTools({
      inject,
      deps: {} as AppDeps,
      locale: 'ru',
      templateId: TID,
      templateName: 'Счёт',
      draft,
    }),
  };
};

describe('createAuthorTools', () => {
  it('get_template_design: черновики и пути тегов', async () => {
    const r = await setup().tools.run('get_template_design', {});
    expect(r).toEqual({
      result: {
        queries: draft.queries,
        params: draft.params,
        tagPaths: { items: 'd.items[i].<column>', params: 'd.params.<name>' },
      },
    });
  });

  it('list_tables, describe_table, check_sql — эндпоинты шаблона', async () => {
    const { inject, tools } = setup();
    await tools.run('list_tables', { search: 'comp' });
    expect(inject).toHaveBeenLastCalledWith(
      'GET',
      `/api/templates/${TID}/schema/tables?search=comp`,
    );
    await tools.run('describe_table', { name: 'public.company' });
    expect(inject).toHaveBeenLastCalledWith(
      'GET',
      `/api/templates/${TID}/schema/tables/public.company`,
    );
    await tools.run('check_sql', { sql: 'select 1' });
    expect(inject).toHaveBeenLastCalledWith('POST', `/api/templates/${TID}/queries/check`, {
      sql: 'select 1',
    });
  });

  it('check_sql: ответ эндпоинта с ошибкой запроса уходит модели как есть', async () => {
    const fail = { ok: false, error: 'столбец "x" не существует' };
    const { tools } = setup({
      [`/api/templates/${TID}/queries/check`]: { status: 200, body: fail },
    });
    expect(await tools.run('check_sql', { sql: 'select x' })).toEqual({ result: fail });
  });

  it('propose_query: проверка SQL в карточке; ключ params и запись — ошибка модели', async () => {
    const { tools } = setup();
    expect(
      await tools.run('propose_query', { key: 'company', mode: 'single', sql: 'select 1 as id' }),
    ).toEqual({
      card: {
        type: 'query',
        templateId: TID,
        templateName: 'Счёт',
        key: 'company',
        mode: 'single',
        sql: 'select 1 as id',
        check: okCheck,
      },
      // Итог проверки виден модели.
      result: { ok: true, check: okCheck },
    });
    const bad = await tools.run('propose_query', { key: 'params', mode: 'list', sql: 'select 1' });
    expect('result' in bad && JSON.stringify(bad.result)).toContain('error');
    const write = await tools.run('propose_query', {
      key: 'x',
      mode: 'list',
      sql: 'delete from company',
    });
    expect('result' in write && JSON.stringify(write.result)).toContain('error');
    // Сообщения схемы — текстом для модели, а не ключами каталога.
    expect(JSON.stringify(write)).not.toContain('v:');
  });

  it('propose_query: сбой проверки — безопасный текст в карточке', async () => {
    const { tools } = setup({
      [`/api/templates/${TID}/queries/check`]: {
        status: 502,
        body: { error: { code: 'DATASOURCE_UNAVAILABLE', message: 'host db-secret:5432' } },
      },
    });
    const r = await tools.run('propose_query', { key: 'a', mode: 'list', sql: 'select 1' });
    expect(r).toMatchObject({
      card: { type: 'query', check: { ok: false } },
      result: { ok: true, check: { ok: false } },
    });
    expect(JSON.stringify(r)).not.toContain('db-secret');
  });

  it('propose_param: схема параметра; неверный — ошибка модели', async () => {
    const { tools } = setup();
    const p = {
      name: 'from',
      label: 'С даты',
      type: 'date',
      required: true,
      defaultValue: null,
      options: null,
      sql: null,
      multiple: false,
    };
    expect(await tools.run('propose_param', { param: p })).toEqual({
      card: { type: 'param', templateId: TID, templateName: 'Счёт', param: p },
    });
    const bad = await tools.run('propose_param', { param: { ...p, name: '1x' } });
    expect('result' in bad && JSON.stringify(bad.result)).toContain('error');
    expect(JSON.stringify(bad)).not.toContain('v:');
  });

  it('propose_param: строгая модель — пропуски и пустые значения приводятся к null/false', async () => {
    const { tools } = setup();
    const r1 = await tools.run('propose_param', {
      param: { name: 'from', label: 'С даты', type: 'date', required: true },
    });
    expect(r1).toEqual({
      card: {
        type: 'param',
        templateId: TID,
        templateName: 'Счёт',
        param: {
          name: 'from',
          label: 'С даты',
          type: 'date',
          required: true,
          defaultValue: null,
          options: null,
          sql: null,
          multiple: false,
        },
      },
    });
    const r2 = await tools.run('propose_param', {
      param: { name: 'n', label: 'N', type: 'number', sql: '', options: [], defaultValue: '' },
    });
    expect(r2).toMatchObject({
      card: {
        param: { defaultValue: null, options: null, sql: null, multiple: false, required: false },
      },
    });
    // SQL у не-query отбрасывается.
    const r3 = await tools.run('propose_param', {
      param: { name: 's', label: 'S', type: 'string', sql: 'select 1' },
    });
    expect(r3).toMatchObject({ card: { param: { sql: null } } });
  });

  it('propose_param: строковый defaultValue приводится по типу и проходит проверку сохранения', async () => {
    const { tools } = setup();
    const propose = async (type: string, defaultValue: string) => {
      const r = await tools.run('propose_param', {
        param: { name: 'p', label: 'P', type, defaultValue },
      });
      return 'card' in r && r.card.type === 'param' ? r.card.param : null;
    };
    const num = await propose('number', '5');
    expect(num?.defaultValue).toBe(5);
    expect(() => checkParamDefaults([num!])).not.toThrow();
    const bool = await propose('boolean', 'TRUE');
    expect(bool?.defaultValue).toBe(true);
    expect(() => checkParamDefaults([bool!])).not.toThrow();
    expect((await propose('boolean', 'false'))?.defaultValue).toBe(false);
    // Неприводимое значение остаётся как есть: его отклонит проверка при сохранении.
    const bad = await propose('number', 'abc');
    expect(bad?.defaultValue).toBe('abc');
    expect(() => checkParamDefaults([bad!])).toThrow();
    // У строковых типов значение не меняется.
    expect((await propose('string', '5'))?.defaultValue).toBe('5');
  });

  it('неверные аргументы — читаемый текст, без ключей каталога', async () => {
    const r = await setup().tools.run('describe_table', { name: '' });
    expect(JSON.stringify(r)).toContain('invalid arguments: name: ');
    expect(JSON.stringify(r)).not.toContain('v:');
    expect(JSON.stringify(r)).not.toContain('"code"');
  });

  it('propose_tags: текст ≤ 2000', async () => {
    const { tools } = setup();
    expect(
      await tools.run('propose_tags', { text: '{d.company.name}', explanation: 'Название' }),
    ).toEqual({
      card: {
        type: 'tags',
        templateId: TID,
        templateName: 'Счёт',
        text: '{d.company.name}',
        explanation: 'Название',
      },
    });
    const long = await tools.run('propose_tags', { text: 'x'.repeat(2001), explanation: '' });
    expect('result' in long).toBe(true);
  });

  it('ошибка эндпоинта схемы — безопасный текст (errorOf)', async () => {
    const { tools } = setup({
      [`/api/templates/${TID}/schema/tables`]: {
        status: 502,
        body: { error: { code: 'DATASOURCE_UNAVAILABLE', message: 'host db-secret:5432' } },
      },
    });
    const r = await tools.run('list_tables', {});
    expect(JSON.stringify(r)).not.toContain('db-secret');
  });

  it('неизвестный инструмент — ошибка модели', async () => {
    expect(await setup().tools.run('toString', {})).toEqual({
      result: { error: 'unknown tool: toString' },
    });
  });
});

describe('mergeTools', () => {
  const set = (name: string): AgentTools => ({
    specs: [{ type: 'function', function: { name, description: '', parameters: {} } }],
    run: vi.fn(async () => ({ result: name })),
  });

  it('спецификации подряд, вызов — владельцу инструмента; неизвестный — первому набору', async () => {
    const a = set('a');
    const b = set('b');
    const m = mergeTools(a, b);
    expect(m.specs.map((s) => s.function.name)).toEqual(['a', 'b']);
    expect(await m.run('b', {})).toEqual({ result: 'b' });
    expect(b.run).toHaveBeenCalledWith('b', {});
    await m.run('zzz', {});
    expect(a.run).toHaveBeenCalledWith('zzz', {});
  });
});
