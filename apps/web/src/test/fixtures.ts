export const adminTemplate = {
  id: 't1',
  name: 'Счёт',
  description: 'Счёт на оплату',
  fileExt: 'docx',
  defaultOutput: 'pdf',
  updatedAt: '2026-01-10T10:00:00Z',
  outputFormats: ['pdf', 'docx', 'odt'],
  datasourceId: 'd1',
  version: 3,
  queries: [{ key: 'company', mode: 'single', sql: 'select 1 as name' }],
  params: [
    {
      name: 'from',
      label: 'С даты',
      type: 'date',
      required: true,
      defaultValue: null,
      options: null,
    },
  ],
  lastSaveError: null,
  lastSaveErrorAt: null,
};
