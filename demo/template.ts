import type { TemplateParam, TemplateQuery } from '@carbone-reports/shared';
import JSZip from 'jszip';

export const DEMO = { datasourceName: 'Демо-база', templateName: 'Счёт (демо)' } as const;

export const DEMO_QUERIES: TemplateQuery[] = [
  {
    key: 'company',
    mode: 'single',
    sql: 'select c.name, c.inn, c.address from company c join invoices i on i.company_id = c.id where i.id = :invoiceId',
  },
  {
    key: 'invoice',
    mode: 'single',
    sql: 'select number, issued_on from invoices where id = :invoiceId',
  },
  {
    key: 'items',
    mode: 'list',
    sql: 'select name, qty, price from invoice_items where invoice_id = :invoiceId order by id',
  },
];

/** Зависимые SQL-списки: «Счёт» перечисляет счета выбранной «Компании» (ссылка :companyId). */
export const DEMO_PARAMS: TemplateParam[] = [
  {
    name: 'companyId',
    label: 'Компания',
    type: 'query',
    required: true,
    defaultValue: 1,
    options: null,
    sql: 'select id as value, name as label from company order by id',
    multiple: false,
  },
  {
    name: 'invoiceId',
    label: 'Счёт',
    type: 'query',
    required: true,
    defaultValue: 1,
    options: null,
    sql: 'select id as value, number as label from invoices where company_id = :companyId order by id',
    multiple: false,
  },
];

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const p = (text: string, bold = false) =>
  `<w:p><w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
const cell = (text: string, width: number) =>
  `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/></w:tcPr>${p(text)}</w:tc>`;
const WIDTHS = [4800, 1600, 2200];
const row = (cells: string[]) =>
  `<w:tr>${cells.map((c, i) => cell(c, WIDTHS[i]!)).join('')}</w:tr>`;
const border = (side: string) =>
  `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="999999"/>`;

/** DOCX «Счёт (демо)»: шапка, реквизиты компании, таблица позиций с циклом Carbone. */
export async function buildDemoTemplate(): Promise<Buffer> {
  const table =
    `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(border).join('')}</w:tblBorders></w:tblPr>` +
    `<w:tblGrid>${WIDTHS.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>` +
    row(['Наименование', 'Кол-во', 'Цена']) +
    row(['{d.items[i].name}', '{d.items[i].qty}', '{d.items[i].price}']) +
    row(['{d.items[i+1].name}', '', '']) +
    '</w:tbl>';
  const body = [
    p('Счёт № {d.invoice.number} от {d.invoice.issued_on}', true),
    p('Поставщик: {d.company.name}'),
    p('Адрес: {d.company.address}'),
    p(''),
    table,
    p(''),
  ].join('');
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip.file(
    '_rels/.rels',
    `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  zip.file(
    'word/document.xml',
    `${XML}<w:document xmlns:w="${W}"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="850" w:bottom="1134" w:left="1701" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`,
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}
