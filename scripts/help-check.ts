// Сверка примеров «Справки по шаблонам» с Carbone поднятого стека (§23.3).
// Запуск: pnpm help:check               — рендер каждого примера через контейнер api (docker compose exec);
//         pnpm help:check -- --self-test — без Docker: сборка DOCX и разбор текста обратимы.
// Carbone наружу не открыт, поэтому раннер выполняется внутри api, как и пробы матрицы Community.
import { execFileSync } from 'node:child_process';
import { CARBONE_LANG } from '@carbone-reports/shared';
import JSZip from 'jszip';
import { communityErrorMessage } from '../apps/api/src/modules/carbone/community';
import { HELP_SECTIONS, type HelpExample } from '../apps/web/src/pages/admin/help/content';

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const unesc = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');

// ---- шаблон → DOCX (весь текст абзаца — один run, как в пробах матрицы) ----

const para = (text: string) => `<w:p><w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
const isRow = (line: string) => line.startsWith('|');
const cellsOf = (line: string) =>
  line
    .trim()
    .slice(1, -1)
    .split('|')
    .map((c) => c.trim());
/** Строка таблицы в нотации справки: «| a | b |», пустая ячейка — «| |». */
const rowLine = (cells: string[]) => `| ${cells.join(' | ')} |`.replace(/\| {2}(?=\|)/g, '| ');

function table(rows: string[][]): string {
  const cols = Math.max(...rows.map((r) => r.length));
  const cell = (c: string) =>
    `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/></w:tcPr>${para(c)}</w:tc>`;
  return (
    '<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/></w:tblPr>' +
    `<w:tblGrid>${'<w:gridCol w:w="2000"/>'.repeat(cols)}</w:tblGrid>` +
    rows.map((r) => `<w:tr>${r.map(cell).join('')}</w:tr>`).join('') +
    '</w:tbl>'
  );
}

function templateBody(template: string): string {
  const out: string[] = [];
  let rows: string[][] = [];
  const flush = () => {
    if (rows.length > 0) out.push(table(rows));
    rows = [];
  };
  for (const line of template.split('\n')) {
    if (isRow(line)) rows.push(cellsOf(line));
    else {
      flush();
      out.push(para(line));
    }
  }
  flush();
  return out.join('');
}

export async function buildDocx(template: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip.file(
    '_rels/.rels',
    `${XML}<Relationships xmlns="${RELS}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  zip.file('word/_rels/document.xml.rels', `${XML}<Relationships xmlns="${RELS}"></Relationships>`);
  zip.file(
    'word/document.xml',
    `${XML}<w:document xmlns:w="${W}"><w:body>${templateBody(template)}<w:p/><w:sectPr/></w:body></w:document>`,
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

// ---- DOCX → текст в нотации справки ----

const TEXT_RE = /<w:t(?:\s[^>]*)?\/>|<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:br\b[^>]*\/>/g;
const BLOCK_RE = /<w:tbl>[\s\S]*?<\/w:tbl>|<w:p(?:\s[^>]*)?\/>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;
const PARA_RE = /<w:p(?:\s[^>]*)?\/>|<w:p(?:\s[^>]*)?>[\s\S]*?<\/w:p>/g;
const ROW_RE = /<w:tr(?:\s[^>]*)?>[\s\S]*?<\/w:tr>/g;
const CELL_RE = /<w:tc(?:\s[^>]*)?>[\s\S]*?<\/w:tc>/g;

function paraText(p: string): string {
  let s = '';
  for (const m of p.matchAll(TEXT_RE)) {
    if (m[0].startsWith('<w:br')) s += '\n';
    else if (m[1] !== undefined) s += unesc(m[1]);
  }
  return s;
}

export function docxText(documentXml: string): string {
  const body = /<w:body>([\s\S]*)<\/w:body>/.exec(documentXml)?.[1] ?? '';
  const lines: string[] = [];
  for (const [block] of body.matchAll(BLOCK_RE)) {
    if (block.startsWith('<w:tbl>')) {
      for (const [row] of block.matchAll(ROW_RE)) {
        const cells = [...row.matchAll(CELL_RE)].map(([c]) =>
          [...c.matchAll(PARA_RE)].map(([p]) => paraText(p)).join(' / '),
        );
        lines.push(rowLine(cells));
      }
    } else {
      const text = paraText(block);
      if (text !== '') lines.push(text);
    }
  }
  return lines.join('\n');
}

async function documentXml(docx: Buffer): Promise<string> {
  const file = (await JSZip.loadAsync(docx)).file('word/document.xml');
  if (!file) throw new Error('в DOCX нет word/document.xml');
  return file.async('string');
}

// ---- проверки ----

function mismatch(e: HelpExample, want: string, got: string): void {
  console.log(`✗ ${e.id} «${e.title}»`);
  console.log(`  ожидалось: ${JSON.stringify(want)}`);
  console.log(`  получено:  ${JSON.stringify(got)}`);
}

/** Без Docker: шаблон, собранный в DOCX, читается обратно в тот же текст (без пустых строк). */
async function selfTest(examples: HelpExample[]): Promise<number> {
  let bad = 0;
  for (const e of examples) {
    const got = docxText(await documentXml(await buildDocx(e.template)));
    const want = e.template
      .split('\n')
      .filter((l) => l !== '')
      .join('\n');
    if (got === want) console.log(`✓ ${e.id}`);
    else {
      bad++;
      mismatch(e, want, got);
    }
  }
  return bad;
}

/** Выполняется внутри контейнера api: как CarboneClient (carbone-version 5, download=true). */
const RUNNER = String.raw`
const base = process.env.CARBONE_URL.replace(/\/$/, '');
const H = { 'carbone-version': '5' };
let buf = '';
process.stdin.on('data', (d) => (buf += d));
process.stdin.on('end', async () => {
  const { lang, convertTo, cases } = JSON.parse(buf);
  const out = [];
  for (const c of cases) {
    const r = { id: c.id };
    try {
      const form = new FormData();
      form.append('template', new Blob([Buffer.from(c.tpl, 'base64')]), 'template.docx');
      const up = await fetch(base + '/template', { method: 'POST', headers: H, body: form });
      const ub = await up.json().catch(() => null);
      const id = ub && ub.data && ub.data.templateId;
      if (!id) {
        r.error = 'загрузка шаблона: HTTP ' + up.status + ' ' + ((ub && ub.error) || '');
        out.push(r);
        continue;
      }
      const res = await fetch(base + '/render/' + encodeURIComponent(id) + '?download=true', {
        method: 'POST',
        headers: { ...H, 'content-type': 'application/json' },
        body: JSON.stringify({
          data: c.data,
          convertTo,
          lang,
          timezone: process.env.TZ || 'Europe/Moscow',
        }),
      });
      const isJson = (res.headers.get('content-type') || '').includes('application/json');
      if (res.ok && !isJson) r.out = Buffer.from(await res.arrayBuffer()).toString('base64');
      else {
        const b = isJson ? await res.json().catch(() => null) : null;
        r.error = (b && b.error) || 'HTTP ' + res.status;
      }
    } catch (e) {
      r.error = 'исключение: ' + e.message;
    }
    out.push(r);
  }
  process.stdout.write(JSON.stringify(out));
});
`;

interface RunnerResult {
  id: string;
  out?: string;
  error?: string;
}

async function liveCheck(examples: HelpExample[]): Promise<number> {
  const cases = await Promise.all(
    examples.map(async (e) => ({
      id: e.id,
      tpl: (await buildDocx(e.template)).toString('base64'),
      data: JSON.parse(e.data) as unknown,
    })),
  );
  const raw = execFileSync('docker', ['compose', 'exec', '-T', 'api', 'node', '-e', RUNNER], {
    input: JSON.stringify({ lang: CARBONE_LANG, convertTo: 'docx', cases }),
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const results = JSON.parse(raw.toString('utf8')) as RunnerResult[];
  let bad = 0;
  for (const e of examples) {
    const r = results.find((x) => x.id === e.id);
    let got: string;
    if (!r) got = '(нет ответа раннера)';
    else if (e.unavailable) {
      got = r.error
        ? (communityErrorMessage(r.error) ?? `другая ошибка: ${r.error}`)
        : 'отчёт сформирован, а ожидалась ошибка «disabled in the Community Edition»';
    } else if (r.error || !r.out) got = `ошибка: ${r.error ?? 'пустой ответ'}`;
    else got = docxText(await documentXml(Buffer.from(r.out, 'base64')));
    if (got === e.result) console.log(`✓ ${e.id}`);
    else {
      bad++;
      mismatch(e, e.result, got);
    }
  }
  return bad;
}

async function main(): Promise<void> {
  const examples = HELP_SECTIONS.flatMap((s) => s.examples);
  const self = process.argv.includes('--self-test');
  const bad = self ? await selfTest(examples) : await liveCheck(examples);
  console.log(
    `${self ? 'самопроверка' : 'Carbone'}: примеров ${examples.length}, расхождений ${bad}`,
  );
  if (bad > 0) process.exit(1);
}

main().catch((e: unknown) => {
  console.error(`✗ ${(e as Error).message}`);
  process.exit(1);
});
