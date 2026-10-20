import type { TagWarning, TemplateExt, TemplateTagWarnings } from '@carbone-reports/shared';
import JSZip from 'jszip';

const MAX_PART_BYTES = 20 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
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
  const words = path.replace(/'[^']*'/g, ' ').split(/[^\p{L}\p{N}_]+/u);
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
    const zip = await JSZip.loadAsync(file);
    let total = 0;
    for (const name of Object.keys(zip.files).sort()) {
      const entry = zip.files[name];
      if (!entry || entry.dir || !PARTS[ext].test(name)) continue;
      const size = (entry as unknown as { _data?: { uncompressedSize?: number } })._data
        ?.uncompressedSize;
      if (typeof size === 'number' && size > MAX_PART_BYTES) continue;
      const xml = await entry.async('string');
      if (xml.length > MAX_PART_BYTES) continue;
      total += xml.length;
      if (total > MAX_TOTAL_BYTES) break;
      // Без тегов XML склеиваются теги, разрезанные Word на несколько фрагментов текста.
      const text = decodeEntities(xml.replace(/<[^>]*>/g, ''));
      for (const m of text.matchAll(/\{([^{}]{1,500})\}/g)) {
        const w = checkTag(m[1] ?? '');
        if (w && !found.has(w.tag)) found.set(w.tag, w);
      }
    }
  } catch {
    return { warnings: [], total: 0 };
  }
  return { warnings: [...found.values()].slice(0, MAX_LISTED), total: found.size };
}
