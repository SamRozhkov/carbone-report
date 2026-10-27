import type { TemplateDetails, TemplateSummary } from '@carbone-reports/shared';
import { describe, expect, it, vi } from 'vitest';
import type { AppDeps } from '../../deps';
import { createAssistantTools, type Inject, shapeForm, shapeOptions, shapeReports } from './tools';

const summary = (name: string, extra: Partial<TemplateSummary> = {}): TemplateSummary => ({
  id: `id-${name}`,
  name,
  description: '',
  fileExt: 'docx',
  defaultOutput: 'pdf',
  updatedAt: '2026-10-01T00:00:00Z',
  category: null,
  editingBy: null,
  ...extra,
});

describe('shapeReports', () => {
  it('поля без лишнего, поиск по названию, описанию, категории без учёта регистра', () => {
    const list = [
      summary('Счёт', { description: 'для покупателя' }),
      summary('Акт', { category: { id: 'c', name: 'Продажи', sortOrder: 0 } }),
      summary('Склад'),
    ];
    expect(shapeReports(list).reports[1]).toEqual({
      id: 'id-Акт',
      name: 'Акт',
      description: '',
      category: 'Продажи',
    });
    expect(shapeReports(list, 'ПОКУПАТ').reports.map((r) => r.name)).toEqual(['Счёт']);
    expect(shapeReports(list, 'продаж').reports.map((r) => r.name)).toEqual(['Акт']);
  });
  it('не больше 50 и общее количество', () => {
    const r = shapeReports(Array.from({ length: 60 }, (_, i) => summary(`R${i}`)));
    expect(r.total).toBe(60);
    expect(r.reports).toHaveLength(50);
  });
});

describe('shapeForm', () => {
  it('карточка конструктора: SQL, запросы и pdfOptions не попадают в результат', () => {
    const admin = {
      id: 't',
      name: 'Счёт',
      description: 'd',
      fileExt: 'docx',
      defaultOutput: 'pdf',
      updatedAt: '',
      category: null,
      editingBy: null,
      outputFormats: ['pdf'],
      signatureAllowed: false,
      signMethod: null,
      datasourceId: 'ds',
      version: 3,
      queries: [{ key: 'q', sql: 'select secret from salaries' }],
      charts: [],
      pdfOptions: { watermark: 'TOP SECRET' },
      params: [
        {
          name: 'company',
          label: 'Компания',
          type: 'query',
          required: true,
          defaultValue: null,
          options: null,
          sql: 'select id from company_secret',
          multiple: false,
          dependsOn: [],
        },
        {
          name: 'kind',
          label: 'Вид',
          type: 'select',
          required: false,
          defaultValue: 'a',
          options: [{ value: 'a', label: 'А' }],
          sql: null,
          multiple: false,
          dependsOn: [],
        },
      ],
    } as unknown as TemplateDetails;
    const shaped = shapeForm(admin);
    const text = JSON.stringify(shaped);
    for (const leak of [
      'salaries',
      'company_secret',
      'TOP SECRET',
      'datasourceId',
      '"sql"',
      'queries',
    ])
      expect(text).not.toContain(leak);
    expect(shaped.params[0]).toEqual({
      name: 'company',
      label: 'Компания',
      type: 'query',
      required: true,
      default: null,
      multiple: false,
      valuesVia: 'find_param_values',
      dependsOn: [],
    });
    expect(shaped.params[1]).toMatchObject({ name: 'kind', options: [{ value: 'a', label: 'А' }] });
  });
});

describe('shapeOptions', () => {
  it('поиск по подписи, ≤30, общее количество', () => {
    const options = Array.from({ length: 40 }, (_, i) => ({ value: i, label: `ООО Ромашка ${i}` }));
    options.push({ value: 99, label: 'АО Лютик' });
    const all = shapeOptions({ options });
    const list = all as { total: number; values: unknown[] };
    expect(list.values).toHaveLength(30);
    expect(list.total).toBe(41);
    const found = shapeOptions({ options }, 'лютик');
    expect(found).toEqual({ total: 1, values: [{ value: 99, label: 'АО Лютик' }] });
  });
  it('ждёт родителей — waitingFor', () => {
    expect(shapeOptions({ options: [], waitingFor: ['region'] })).toEqual({
      waitingFor: ['region'],
    });
  });
});

const RID = '0b6a4c1e-5f2d-4e8a-9c3b-7d1e2f3a4b5c';

describe('createAssistantTools: имя инструмента', () => {
  it('имена из прототипа объекта — неизвестный инструмент, а не исключение', async () => {
    const inject = vi.fn<Inject>();
    const tools = createAssistantTools({ inject, deps: {} as AppDeps, locale: 'ru' });
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'nonexistent']) {
      expect(await tools.run(name, {})).toEqual({ result: { error: `unknown tool: ${name}` } });
    }
    expect(inject).not.toHaveBeenCalled();
  });
});

describe('createAssistantTools: ошибки эндпоинтов', () => {
  const failing = (status: number, code: string, message: string) => {
    const body = { error: { code, message } };
    const inject = vi.fn<Inject>(async () => ({ status, body }));
    const onError = vi.fn();
    const tools = createAssistantTools({ inject, deps: {} as AppDeps, locale: 'ru', onError });
    return { tools, onError, body };
  };
  const args = { reportId: RID, param: 'company' };

  it.each(['NOT_FOUND', 'FORBIDDEN', 'UNAUTHORIZED', 'VALIDATION', 'TOO_MANY_OPTIONS', 'TIMEOUT'])(
    '%s — текст ошибки уходит модели',
    async (code) => {
      const { tools } = failing(400, code, 'понятный текст');
      expect(await tools.run('find_param_values', args)).toEqual({
        result: { error: 'понятный текст', status: 400 },
      });
    },
  );

  it('SQL_ERROR и прочие коды — общий текст; настоящая ошибка — в onError', async () => {
    const { tools, onError, body } = failing(
      400,
      'SQL_ERROR',
      'Ошибка SQL: column "secret_col_xyz" does not exist',
    );
    const r = await tools.run('find_param_values', args);
    expect(JSON.stringify(r)).not.toContain('secret_col_xyz');
    expect(r).toEqual({ result: { error: 'parameter values unavailable', status: 400 } });
    expect(onError).toHaveBeenCalledWith('find_param_values', 400, body);

    const other = failing(400, 'CONFIG', 'unknown param :secret_param');
    const l = await other.tools.run('list_reports', {});
    expect(JSON.stringify(l)).not.toContain('secret_param');
    expect(l).toEqual({ result: { error: 'request failed', status: 400 } });
  });

  it('тело без кода — общий текст', async () => {
    const inject = vi.fn<Inject>(async () => ({ status: 500, body: null }));
    const tools = createAssistantTools({ inject, deps: {} as AppDeps, locale: 'ru' });
    expect(await tools.run('get_report_form', { reportId: RID })).toEqual({
      result: { error: 'request failed', status: 500 },
    });
  });
});

describe('схемы инструментов', () => {
  // GigaChat (через gpt2giga) отклоняет объект без properties: 422 «Field '…properties' is missing».
  const objectsWithoutProperties = (schema: unknown, path: string): string[] => {
    if (!schema || typeof schema !== 'object') return [];
    const s = schema as Record<string, unknown>;
    const own = s.type === 'object' && !('properties' in s) ? [path] : [];
    const props = (s.properties ?? {}) as Record<string, unknown>;
    return [
      ...own,
      ...Object.entries(props).flatMap(([k, v]) => objectsWithoutProperties(v, `${path}.${k}`)),
      ...objectsWithoutProperties(s.items, `${path}[]`),
    ];
  };

  it('у каждого объекта в параметрах есть properties', () => {
    const tools = createAssistantTools({
      inject: vi.fn(),
      deps: {} as AppDeps,
      locale: 'ru',
    });
    const bad = tools.specs.flatMap((t) =>
      objectsWithoutProperties(t.function.parameters, t.function.name),
    );
    expect(bad).toEqual([]);
  });
});

describe('reportId: название вместо id', () => {
  // GigaChat передаёт название отчёта вместо id из list_reports.
  const list = [
    { id: RID, name: 'Счёт (демо)' },
    { id: '1c2d3e4f-0000-4000-8000-000000000001', name: 'Акт' },
  ];
  const setup = () => {
    const inject = vi.fn<Inject>(async (_m, url) =>
      url === '/api/templates'
        ? { status: 200, body: list }
        : { status: 200, body: { id: RID, name: 'Счёт (демо)', description: '', params: [] } },
    );
    return { inject, tools: createAssistantTools({ inject, deps: {} as AppDeps, locale: 'ru' }) };
  };

  it('точное название без учёта регистра — id из доступного списка', async () => {
    const { inject, tools } = setup();
    const r = await tools.run('get_report_form', { reportId: ' счёт (ДЕМО) ' });
    expect(r).toEqual({ result: { id: RID, name: 'Счёт (демо)', description: '', params: [] } });
    expect(inject).toHaveBeenLastCalledWith('GET', `/api/templates/${RID}`);
  });

  it('id не ищется в списке', async () => {
    const { inject, tools } = setup();
    await tools.run('get_report_form', { reportId: RID });
    expect(inject).toHaveBeenCalledTimes(1);
  });

  it('нет совпадения — подсказка модели, эндпоинт шаблона не вызывается', async () => {
    const { inject, tools } = setup();
    expect(await tools.run('find_param_values', { reportId: 'Счёт', param: 'company' })).toEqual({
      result: { error: 'reportId must be the "id" value from list_reports, not the report name' },
    });
    expect(inject).toHaveBeenCalledTimes(1);
    expect(inject).toHaveBeenCalledWith('GET', '/api/templates');
  });
});
