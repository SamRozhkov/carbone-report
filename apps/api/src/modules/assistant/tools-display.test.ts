import { describe, expect, it, vi } from 'vitest';
import type { AppDeps } from '../../deps';
import { createAssistantTools, type Inject } from './tools';

// Подписи карточки (display): сбой поиска подписей после успешной проверки не должен
// ронять propose_run — показываются сами значения.
vi.mock('../templates/service', () => ({
  loadTemplateFull: vi.fn(async () => ({
    params: [
      {
        name: 'company',
        label: 'Компания',
        type: 'query',
        required: true,
        defaultValue: null,
        options: null,
        sql: 'select 1',
        multiple: false,
        dependsOn: [],
      },
    ],
  })),
}));
vi.mock('../queries/params', () => ({ resolveParams: (_p: unknown, input: unknown) => input }));
vi.mock('../queries/param-options', () => ({
  validateQueryParams: vi.fn(async () => undefined),
  optionsForParam: vi.fn(async () => {
    throw new Error('connection refused');
  }),
}));

describe('propose_run: подписи значений', () => {
  it('поиск подписей упал — карточка с исходными значениями', async () => {
    const details = { id: 't', name: 'Счёт', outputFormats: ['pdf'], defaultOutput: 'pdf' };
    const inject = vi.fn<Inject>(async () => ({ status: 200, body: details }));
    const tools = createAssistantTools({ inject, deps: {} as AppDeps, locale: 'ru' });
    const r = await tools.run('propose_run', { reportId: 't', params: { company: 2 } });
    expect(r).toEqual({
      card: {
        reportId: 't',
        reportName: 'Счёт',
        params: { company: 2 },
        display: [{ label: 'Компания', value: '2' }],
        outputFormats: ['pdf'],
        defaultOutput: 'pdf',
      },
    });
  });
});
