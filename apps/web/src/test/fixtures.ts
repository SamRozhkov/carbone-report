import type { PdfOptions, TemplateAttachment, TemplateChart } from '@carbone-reports/shared';

export const adminTemplate = {
  id: 't1',
  name: 'Счёт',
  description: 'Счёт на оплату',
  fileExt: 'docx',
  defaultOutput: 'pdf',
  updatedAt: '2026-01-10T10:00:00Z',
  outputFormats: ['pdf', 'docx', 'odt'],
  signatureAllowed: false,
  signMethod: null,
  datasourceId: 'd1',
  version: 3,
  queries: [{ key: 'company', mode: 'single', sql: 'select 1 as name' }],
  charts: [] as TemplateChart[],
  pdfOptions: { pdfa: false } as PdfOptions,
  attachments: [] as TemplateAttachment[],
  pdfPasswordSet: false,
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
  editingBy: null,
};
