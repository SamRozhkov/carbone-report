#!/usr/bin/env node
// Сверка документации на русском и английском (§48.3).
// Использование: node scripts/docs-check.mjs [--root <каталог>] [--only <файл.md>]
// Для каждой пары X.md ↔ X.en.md: переключатель языка в первой строке, одинаковые уровни
// заголовков, одинаковые блоки кода (с точностью до комментариев и заполнителей <…>),
// существующие файлы и якоря у относительных ссылок. Ошибки — «файл:строка: …», код выхода 1.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Русские документы, у которых есть английская пара. Новый документ — сюда же. */
export const DOC_PAIRS = [
  'README.md',
  'docs/localization.md',
  'docs/operations/gost-signature.md',
  'docs/operations/keycloak.md',
];

export const enPath = (ruPath) => ruPath.replace(/\.md$/, '.en.md');

/** Ожидаемая первая строка документа пары. */
export function switcherLine(ruPath, lang) {
  const ru = basename(ruPath);
  const en = basename(enPath(ruPath));
  return lang === 'ru' ? `**Русский** · [English](${en})` : `[Русский](${ru}) · **English**`;
}

/**
 * Заголовки, блоки кода и относительные ссылки документа; номера строк — с 1.
 * Блок кода открывается ``` или ~~~ (3 и больше) и закрывается тем же символом не короче.
 */
export function parseDoc(text) {
  const lines = text.split(/\r?\n/);
  const headings = [];
  const blocks = [];
  const links = [];
  let fence = null;
  lines.forEach((line, i) => {
    const n = i + 1;
    if (fence) {
      const close = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.len) {
        blocks.push({ line: fence.line, lines: fence.lines });
        fence = null;
      } else fence.lines.push({ n, text: line });
      return;
    }
    const open = /^\s*(`{3,}|~{3,})/.exec(line);
    if (open) {
      fence = { char: open[1][0], len: open[1].length, line: n, lines: [] };
      return;
    }
    const h = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
    if (h) headings.push({ level: h[1].length, text: h[2], line: n });
    const prose = line.replace(/`[^`]*`/g, '');
    const targets = [...prose.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)].map((m) => m[1]);
    const ref = /^\s*\[[^\]]+\]:\s*(\S+)/.exec(prose);
    if (ref) targets.push(ref[1]);
    for (const target of targets) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('/')) continue;
      links.push({ target, line: n });
    }
  });
  return { lines, headings, blocks, links };
}

/** Якорь заголовка, как его строит GitHub. */
export function slugify(text) {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M} _-]/gu, '')
    .replace(/ /g, '-');
}

/** Множество якорей документа; повторы получают -1, -2… */
export function anchorsOf(headings) {
  const seen = new Map();
  const result = new Set();
  for (const h of headings) {
    const base = slugify(h.text);
    const k = seen.get(base) ?? 0;
    seen.set(base, k + 1);
    result.add(k ? `${base}-${k}` : base);
  }
  return result;
}

/** Строки блока без комментариев, с заполнителями <> и без пробелов в конце. */
export function normalizeCode(lines) {
  return lines
    .filter((l) => !/^\s*(#|\/\/)/.test(l.text))
    .map((l) => ({
      n: l.n,
      text: l.text
        .replace(/\s+(#|\/\/)\s.*$/, '')
        .replace(/<[^<>]*>/g, '<>')
        .replace(/\s+$/, ''),
    }));
}

function readDoc(root, rel) {
  const file = join(root, rel);
  return existsSync(file) ? parseDoc(readFileSync(file, 'utf8')) : null;
}

/** Ссылки документа rel: файл существует, якорь есть среди заголовков файла. */
export function checkLinks(root, rel, doc) {
  const errors = [];
  const cache = new Map();
  for (const { target, line } of doc.links) {
    const [rawPath, rawAnchor] = target.split('#');
    const path = decodeURIComponent(rawPath);
    const anchor = rawAnchor === undefined ? null : decodeURIComponent(rawAnchor);
    const targetRel = path ? normalize(join(dirname(rel), path)) : rel;
    if (!existsSync(join(root, targetRel))) {
      errors.push(`${rel}:${line}: нет файла ${path}`);
      continue;
    }
    if (anchor === null || !targetRel.endsWith('.md')) continue;
    if (!cache.has(targetRel)) {
      const parsed = targetRel === rel ? doc : readDoc(root, targetRel);
      cache.set(targetRel, anchorsOf(parsed.headings));
    }
    if (!cache.get(targetRel).has(anchor))
      errors.push(`${rel}:${line}: нет заголовка #${anchor} в ${targetRel}`);
  }
  return errors;
}

/** Ошибки одной пары: русский файл ruRel и его английская версия. */
export function checkPair(root, ruRel) {
  const enRel = enPath(ruRel);
  const ru = readDoc(root, ruRel);
  const en = readDoc(root, enRel);
  const errors = [];
  if (!ru) errors.push(`${ruRel}: нет файла`);
  if (!en) errors.push(`${enRel}: нет файла`);
  if (!ru || !en) {
    // Ссылки существующего документа проверяются и без пары.
    if (ru) errors.push(...checkLinks(root, ruRel, ru));
    if (en) errors.push(...checkLinks(root, enRel, en));
    return errors;
  }

  for (const [rel, doc, lang] of [
    [ruRel, ru, 'ru'],
    [enRel, en, 'en'],
  ]) {
    const want = switcherLine(ruRel, lang);
    if (doc.lines[0] !== want) errors.push(`${rel}:1: первая строка должна быть «${want}»`);
  }

  const count = Math.max(ru.headings.length, en.headings.length);
  for (let i = 0; i < count; i++) {
    const a = ru.headings[i];
    const b = en.headings[i];
    if (a && b && a.level === b.level) continue;
    const show = (rel, h) =>
      h ? `${rel}:${h.line}: ${'#'.repeat(h.level)} ${h.text}` : `${rel}: заголовка нет`;
    errors.push(`заголовки расходятся с №${i + 1}:\n  ${show(ruRel, a)}\n  ${show(enRel, b)}`);
    break;
  }

  if (ru.blocks.length !== en.blocks.length) {
    errors.push(`${ruRel}, ${enRel}: блоков кода: ${ru.blocks.length} и ${en.blocks.length}`);
  } else {
    ru.blocks.forEach((block, i) => {
      const a = normalizeCode(block.lines);
      const b = normalizeCode(en.blocks[i].lines);
      const len = Math.max(a.length, b.length);
      for (let j = 0; j < len; j++) {
        if (a[j]?.text === b[j]?.text) continue;
        const where = (rel, l, start) =>
          `${rel}:${l ? l.n : start}: ${l ? l.text : '(конец блока)'}`;
        errors.push(
          `блок кода ${i + 1} расходится:\n  ${where(ruRel, a[j], block.line)}\n  ${where(enRel, b[j], en.blocks[i].line)}`,
        );
        break;
      }
    });
  }

  errors.push(...checkLinks(root, ruRel, ru), ...checkLinks(root, enRel, en));
  return errors;
}

export function checkAll(root, pairs = DOC_PAIRS) {
  return pairs.flatMap((rel) => checkPair(root, rel));
}

function main(argv) {
  let root = fileURLToPath(new URL('..', import.meta.url));
  let pairs = DOC_PAIRS;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') root = argv[++i];
    else if (argv[i] === '--only') pairs = [argv[++i]];
  }
  const errors = checkAll(root, pairs);
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else console.log(`docs:check: пар проверено — ${pairs.length}`);
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  main(process.argv.slice(2));
}
