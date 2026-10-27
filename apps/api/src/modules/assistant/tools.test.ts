import type { TemplateDetails, TemplateSummary } from '@carbone-reports/shared';
import { describe, expect, it } from 'vitest';
import { shapeForm, shapeOptions, shapeReports } from './tools';

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
