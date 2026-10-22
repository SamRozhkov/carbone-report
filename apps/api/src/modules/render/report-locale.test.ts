// Язык отчёта до настоящего Carbone (§45.3, §45.6): renderReport → встроенный рендерер → поток пула.
// Формат шаблона (docx) — без OnlyOffice.
import { LOCALES, type Locale } from '@carbone-reports/shared/i18n';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppDeps } from '../../deps';
import { renderReport } from '../reports/service';
import { createRenderHandoff } from './handoff';
import { RenderPool } from './pool';
import { createEmbeddedRenderer } from './renderer';
import { renderWorkerUrl } from './worker-url';

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const TAGS = "[{d.date:formatD('LL')}] [{d.n:formatN(2)}] [{d.n:formatC(2)}]";

async function template(): Promise<Buffer> {
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
    `${XML}<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t xml:space="preserve">${TAGS}</w:t></w:r></w:p></w:body></w:document>`,
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function text(out: Buffer): Promise<string> {
  const xml = await (await JSZip.loadAsync(out)).file('word/document.xml')!.async('string');
  return [...xml.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join('');
}

let pool: RenderPool;
let deps: AppDeps;

beforeAll(async () => {
  const worker = renderWorkerUrl();
  pool = new RenderPool({ size: 1, workerUrl: worker.url, execArgv: worker.execArgv });
  const carbone = createEmbeddedRenderer({
    pool,
    handoff: createRenderHandoff(new TextEncoder().encode('k'.repeat(32))),
    convert: () => Promise.reject(new Error('OnlyOffice не нужен')),
    selfUrl: 'http://127.0.0.1:3000',
    imageUrlAllowlist: [],
    imageUrlTimeoutMs: 1000,
  });
  deps = {
    carbone,
    config: { tz: 'Europe/Moscow', renderTimeoutMs: 30_000 },
  } as unknown as AppDeps;
});

afterAll(async () => {
  await pool?.destroy();
});

const render = async (locale: Locale) => {
  const tpl = await template();
  const out = await renderReport(
    deps,
    { id: 't1', version: 1, ext: 'docx', read: async () => tpl },
    { date: '2026-10-19', n: 1234567.891 },
    'docx',
    locale,
  );
  return text(out);
};

describe('renderReport: язык отчёта в Carbone (§45.3)', () => {
  it.each<[Locale, string]>([
    // ru — как до 2.14.0 (lang 'ru', §23.4): русские разделители и рубли.
    ['ru', '[19 октября 2026 г.] [1 234 567,89] [1 234 567,89 ₽]'],
    ['en', '[October 19, 2026] [1,234,567.89] [$1,234,567.89]'],
    ['de', '[19. Oktober 2026] [1.234.567,89] [1.234.567,89 €]'],
    ['zh-CN', '[2026年10月19日] [1,234,567.89] [1,234,567.89 ¥]'],
  ])(
    '%s: месяц, разделители и валюта языка',
    async (locale, expected) => {
      expect(await render(locale)).toBe(expected);
    },
    40_000,
  );

  it('валюта formatC по умолчанию следует за языком: RUB, USD, EUR, BRL, EUR, EUR, CNY', async () => {
    const symbols: string[] = [];
    for (const l of LOCALES) symbols.push((await render(l)).split(' [').at(-1)!);
    expect(symbols.map((s) => /[₽$€¥]|R\$/.exec(s)?.[0])).toEqual([
      '₽',
      '$',
      '€',
      'R$',
      '€',
      '€',
      '¥',
    ]);
  }, 60_000);
});
