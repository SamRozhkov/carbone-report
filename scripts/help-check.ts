// Сверка примеров «Справки по шаблонам» со встроенной сборкой Carbone (§23.3).
// Запуск: pnpm help:check               — рендер каждого примера встроенной сборкой Carbone
//                                         (`packages/carbone`) так же, как API; стек не нужен;
//         pnpm help:check -- --self-test — только сборка DOCX и разбор текста обратимы.
import carbone from '@carbone-reports/carbone';
import { CARBONE_LANG } from '@carbone-reports/shared';
import JSZip from 'jszip';
import { communityErrorMessage } from '../apps/api/src/modules/carbone/community';
import { HELP_SECTIONS, type HelpExample } from '../apps/web/src/pages/admin/help/content';

const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const NS =
  `xmlns:w="${W}"` +
  ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"' +
  ' xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"' +
  ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"' +
  ' xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"';
/** PNG 1×1 — картинка-заглушка для примеров с `picture`. */
const PLACEHOLDER_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escAttr = (s: string) => esc(s).replace(/"/g, '&quot;');
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

/** Абзац с картинкой-заглушкой 2,54 × 2,54 см («в тексте»); тег — в её замещающем тексте (descr). */
function pictureBody(tag: string): string {
  const alt = escAttr(tag);
  return (
    '<w:p><w:r><w:drawing><wp:inline><wp:extent cx="914400" cy="914400"/>' +
    `<wp:docPr id="1" name="Picture 1" descr="${alt}"/>` +
    '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic>' +
    `<pic:nvPicPr><pic:cNvPr id="1" name="p.png" descr="${alt}"/><pic:cNvPicPr/></pic:nvPicPr>` +
    '<pic:blipFill><a:blip r:embed="rIdImg"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
    '<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm>' +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>' +
    '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>'
  );
}

/** DOCX из шаблона в нотации справки; `picture` — тег в замещающем тексте картинки-заглушки. */
export async function buildDocx(template: string, picture = false): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip.file(
    '_rels/.rels',
    `${XML}<Relationships xmlns="${RELS}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  zip.file(
    'word/_rels/document.xml.rels',
    picture
      ? `${XML}<Relationships xmlns="${RELS}"><Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/p.png"/></Relationships>`
      : `${XML}<Relationships xmlns="${RELS}"></Relationships>`,
  );
  if (picture) zip.file('word/media/p.png', Buffer.from(PLACEHOLDER_PNG, 'base64'));
  const body = picture ? pictureBody(template) : templateBody(template);
  zip.file(
    'word/document.xml',
    `${XML}<w:document ${NS}><w:body>${body}<w:p/><w:sectPr/></w:body></w:document>`,
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

/**
 * Пример с `picture`: результат — изображение, текст сверить нельзя. Проверяется, что картинка-заглушка
 * заменена новым файлом (`cr-img-…` в связях и в архиве), а тег убран из замещающего текста.
 */
async function pictureProblem(docx: Buffer, tag: string): Promise<string | null> {
  const zip = await JSZip.loadAsync(docx);
  const rels = (await zip.file('word/_rels/document.xml.rels')?.async('string')) ?? '';
  const target = /Target="(media\/cr-img-[^"]+)"/.exec(rels)?.[1];
  if (!target) return 'картинка-заглушка не заменена (нет связи media/cr-img-…)';
  if (!zip.file(`word/${target}`)) return `в архиве нет word/${target}`;
  if ((await documentXml(docx)).includes(escAttr(tag))) return 'тег остался в замещающем тексте';
  return null;
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
    if (e.picture) {
      const ok = (await documentXml(await buildDocx(e.template, true))).includes(
        `descr="${escAttr(e.template)}"`,
      );
      if (ok) console.log(`✓ ${e.id}`);
      else {
        bad++;
        console.log(`✗ ${e.id} «${e.title}»: тега нет в замещающем тексте картинки`);
      }
      continue;
    }
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

async function liveCheck(examples: HelpExample[]): Promise<number> {
  const timezone = process.env.TZ || 'Europe/Moscow';
  let bad = 0;
  for (const e of examples) {
    let got: string;
    try {
      const out = await carbone.renderBuffer(
        await buildDocx(e.template, e.picture === true),
        'docx',
        JSON.parse(e.data) as unknown,
        { lang: CARBONE_LANG, timezone },
      );
      if (e.unavailable) {
        got = 'отчёт сформирован, а ожидалась ошибка «disabled in the Community Edition»';
      } else if (e.picture) {
        got = (await pictureProblem(out, e.template)) ?? e.result;
      } else {
        got = docxText(await documentXml(out));
        if (got.trim() === '') got = 'пустой текст документа';
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      got = e.unavailable
        ? (communityErrorMessage(message) ?? `другая ошибка: ${message}`)
        : `ошибка: ${message}`;
    }
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
  if (examples.length === 0) throw new Error('нет примеров для проверки (справка пуста)');
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
