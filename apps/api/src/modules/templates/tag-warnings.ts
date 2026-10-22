import type { TagWarning, TemplateExt, TemplateTagWarnings } from '@carbone-reports/shared';
import { AppError } from '../../lib/errors';
import { extract, readDirectory } from './transfer/archive';

const MAX_PART_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_ENTRIES = 5000;
const MAX_LISTED = 20;

/** Какие части архива просматриваем для каждого формата. */
const PARTS: Record<TemplateExt, RegExp> = {
  docx: /^word\/(document|header[^/]*|footer[^/]*|footnotes|endnotes)\.xml$/,
  xlsx: /^xl\/(sharedStrings\.xml|worksheets\/[^/]+\.xml)$/,
  pptx: /^ppt\/slides\/[^/]+\.xml$/,
  odt: /^(content|styles)\.xml$/,
  ods: /^(content|styles)\.xml$/,
};

const CYRILLIC = /[Ѐ-ӿ]/;
const LATIN = /[A-Za-z]/;

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (m, h: string) => codePoint(parseInt(h, 16), m))
    .replace(/&#(\d+);/g, (m, d: string) => codePoint(parseInt(d, 10), m))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function codePoint(n: number, fallback: string): string {
  try {
    return String.fromCodePoint(n);
  } catch {
    return fallback;
  }
}

/** Часть до первого `:` вне кавычек и скобок — путь к данным без форматтеров. */
function tagPath(body: string): string {
  let quote = false;
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "'") quote = !quote;
    else if (quote) continue;
    else if (ch === '[') depth++;
    else if (ch === ']') depth = Math.max(0, depth - 1);
    else if (ch === ':' && depth === 0) return body.slice(0, i);
  }
  return body;
}

function checkTag(body: string): TagWarning | null {
  const path = tagPath(body).trim();
  const root = path.split(/[.[]/, 1)[0] ?? '';
  const tag = `{${body}}`;
  if (root === 'с' || root === 'С') return { tag, word: root, letters: [root] };
  if (root !== 'd' && root !== 'c') return null;
  // Значения фильтров `[name=Ромашка_Inc]` — данные, а не идентификаторы.
  const words = path
    .replace(/'[^']*'/g, ' ')
    .replace(/\[([^\]=]*)[^\]]*\]/g, '[$1]')
    .split(/[^\p{L}\p{N}_]+/u);
  for (const word of words) {
    if (LATIN.test(word) && CYRILLIC.test(word)) {
      return { tag, word, letters: [...new Set([...word].filter((c) => CYRILLIC.test(c)))] };
    }
  }
  return null;
}

/** Теги Carbone с русскими буквами среди латинских: такие теги не находят данные. Сломанный архив — пустой результат. */
export async function findTagWarnings(
  file: Buffer,
  ext: TemplateExt,
): Promise<TemplateTagWarnings> {
  const found = new Map<string, TagWarning>();
  try {
    const limits = { archiveBytes: 0, unpackedBytes: 0, entries: MAX_ENTRIES };
    // Свой разбор zip: размер считается по фактически распакованным байтам, а не по заголовку.
    const entries = readDirectory(file, limits)
      .filter((e) => PARTS[ext].test(e.name))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    let used = 0;
    for (const entry of entries) {
      let data: Buffer;
      try {
        const budget = Math.min(MAX_PART_BYTES, MAX_TOTAL_BYTES - used);
        if (budget <= 0) break;
        data = await extract(
          file,
          entry,
          budget,
          () => new AppError('TOO_BIG', 400, { key: 'archive.partTooLarge' }),
        );
      } catch {
        continue; // слишком большая или повреждённая часть пропускается
      }
      used += data.length;
      // Конец абзаца, ячейки и строки — разделитель: теги не склеиваются через границы.
      const text = decodeEntities(
        data
          .toString('utf8')
          .replace(/<\/(?:w:p|a:p|si|text:p|c|row)>/g, '\n')
          .replace(/<[^>]*>/g, ''),
      );
      for (const m of text.matchAll(/\{([^{}\n]{1,500})\}/g)) {
        const w = checkTag(m[1] ?? '');
        if (w && !found.has(w.tag)) found.set(w.tag, w);
      }
    }
  } catch {
    return { warnings: [], total: 0 };
  }
  return { warnings: [...found.values()].slice(0, MAX_LISTED), total: found.size };
}
