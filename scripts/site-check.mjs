#!/usr/bin/env node
// Проверка сайта продукта (§49.4).
// Использование: node scripts/site-check.mjs [--root <корень репозитория>]
// Проверяет site/: страницы ru и en с переключателем языка, относительные ссылки внутри site/,
// alt/width/height у <img>, одинаковый набор снимков ru/en (= SHOTS) и показ каждого на своей
// странице, размеры файлов, отсутствие <script> и внешних ресурсов, версию в подвале = CHANGELOG.
// Ошибки — «файл[:строка]: …», код выхода 1; неверные аргументы — сообщение в stderr, код 2.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, posix, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Снимки §49.2 (без расширения), одинаковые для всех языков. */
export const SHOTS = [
  'login',
  'reports',
  'run',
  'history',
  'editor-sql',
  'editor-document',
  'signature',
  'access',
  'users',
  'datasources',
];
export const LANGS = ['ru', 'en'];
export const PAGES = { ru: 'index.html', en: 'en/index.html' };
export const MAX_SHOT = 600 * 1024;
export const MAX_SITE = 10 * 1024 * 1024;

const OTHER = { ru: 'en/index.html', en: '../index.html' };

/** Теги с атрибутами и номером строки. */
function tags(html) {
  const out = [];
  for (const m of html.matchAll(/<([a-zA-Z]+)\b([^>]*)>/g)) {
    const attrs = {};
    for (const a of m[2].matchAll(/([\w-]+)\s*=\s*"([^"]*)"/g)) attrs[a[1].toLowerCase()] = a[2];
    out.push({ name: m[1].toLowerCase(), attrs, line: html.slice(0, m.index).split('\n').length });
  }
  return out;
}

const isAbsolute = (url) => /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('//');

function walk(dir) {
  const files = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) files.push(...walk(p));
    else files.push(p);
  }
  return files;
}

function changelogVersion(root) {
  const p = join(root, 'CHANGELOG.md');
  if (!existsSync(p)) return null;
  return /^## \[(\d+\.\d+\.\d+)\]/m.exec(readFileSync(p, 'utf8'))?.[1] ?? null;
}

function checkPage(root, lang, version, errors) {
  const rel = `site/${PAGES[lang]}`;
  const file = join(root, rel);
  if (!existsSync(file)) {
    errors.push(`${rel}: нет файла`);
    return;
  }
  const html = readFileSync(file, 'utf8');
  const err = (line, msg) => errors.push(`${rel}:${line}: ${msg}`);
  const all = tags(html);

  // 1. Переключатель — первый элемент после <body>, ссылка на страницу другого языка.
  const body = all.findIndex((t) => t.name === 'body');
  const first = all[body + 1];
  const nav = /<nav class="lang">([\s\S]*?)<\/nav>/.exec(html);
  if (!first || first.name !== 'nav' || first.attrs.class !== 'lang' || !nav)
    err(first?.line ?? 1, 'первым элементом <body> должен быть переключатель <nav class="lang">');
  else if (!nav[1].includes(`href="${OTHER[lang]}"`))
    err(first.line, `переключатель: нет ссылки на ${OTHER[lang]}`);

  // 6. Внешние ресурсы и скрипты.
  for (const t of all) {
    if (t.name === 'script') err(t.line, '<script> на сайте не допускается');
    const res =
      t.name === 'link'
        ? t.attrs.href
        : ['img', 'source', 'iframe'].includes(t.name)
          ? t.attrs.src
          : null;
    if (res && isAbsolute(res)) err(t.line, `внешний ресурс ${res}`);
  }

  // 2. Относительные ссылки — существующие файлы внутри site/.
  const siteDir = join(root, 'site');
  const shown = new Set();
  for (const t of all) {
    const url = t.attrs.src ?? t.attrs.href;
    if (url === undefined || url === '' || url.startsWith('#') || isAbsolute(url)) continue;
    const path = decodeURIComponent(url.split(/[?#]/)[0]);
    const target = join(dirname(file), path);
    const inside = relative(siteDir, target);
    if (inside.startsWith('..')) {
      err(t.line, `ссылка ${url} ведёт за пределы site/ (на Pages её нет — нужен абсолютный URL)`);
      continue;
    }
    if (!existsSync(target))
      err(t.line, `ссылка ${url}: нет файла site/${inside.split('\\').join('/')}`);
    const shot = /^shots\/([^/]+)\/([^/]+)\.png$/.exec(inside.split('\\').join('/'));
    if (shot && t.name === 'img') {
      if (shot[1] !== lang) err(t.line, `снимок другого языка: ${url}`);
      else shown.add(shot[2]);
    }
  }

  // 3. alt, width, height у <img>.
  for (const t of all.filter((x) => x.name === 'img'))
    for (const a of ['alt', 'width', 'height'])
      if (!t.attrs[a]?.trim()) err(t.line, `<img src="${t.attrs.src ?? ''}">: нет ${a}`);

  // 4. Каждый снимок языка показан на странице.
  for (const s of SHOTS)
    if (!shown.has(s)) errors.push(`${rel}: снимок не показан на странице: ${s}`);

  // 7. Версия в подвале.
  const v = /data-version="([^"]*)"/.exec(html)?.[1];
  if (!v) errors.push(`${rel}: нет элемента с data-version`);
  else if (version && v !== version)
    errors.push(`${rel}: версия ${v}, а в CHANGELOG.md — ${version}`);
}

/** Все ошибки сайта root/site; root — корень репозитория. */
export function checkSite(root) {
  const errors = [];
  const siteDir = join(root, 'site');
  if (!existsSync(siteDir)) return ['site: нет каталога'];
  const version = changelogVersion(root);
  if (!version) errors.push('CHANGELOG.md: не найдена версия «## [X.Y.Z]»');
  for (const lang of LANGS) checkPage(root, lang, version, errors);

  // 4. Набор снимков в каждом каталоге = SHOTS.
  for (const lang of LANGS) {
    const dir = join(siteDir, 'shots', lang);
    const have = existsSync(dir) ? readdirSync(dir).filter((f) => !f.startsWith('.')) : [];
    for (const f of have)
      if (!SHOTS.includes(f.replace(/\.png$/, '')) || !f.endsWith('.png'))
        errors.push(`site/shots/${lang}: лишний снимок ${f}`);
    for (const s of SHOTS)
      if (!have.includes(`${s}.png`)) errors.push(`site/shots/${lang}: нет снимка ${s}.png`);
  }

  // 5. Размеры.
  let total = 0;
  for (const f of walk(siteDir)) {
    const size = statSync(f).size;
    total += size;
    const rel = posix.join('site', relative(siteDir, f).split('\\').join('/'));
    if (f.endsWith('.png') && size > MAX_SHOT)
      errors.push(`${rel}: больше 600 КБ (${Math.ceil(size / 1024)} КБ)`);
  }
  if (total > MAX_SITE) errors.push(`site: больше 10 МБ (${(total / 1048576).toFixed(1)} МБ)`);
  return errors;
}

function main(argv) {
  let root = fileURLToPath(new URL('..', import.meta.url));
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag !== '--root') {
      console.error(`site:check: неизвестный аргумент ${flag}`);
      process.exitCode = 2;
      return;
    }
    const value = argv[++i];
    if (value === undefined) {
      console.error(`site:check: у ${flag} нет значения`);
      process.exitCode = 2;
      return;
    }
    root = value;
  }
  const errors = checkSite(root);
  if (errors.length) {
    console.error(errors.join('\n'));
    process.exitCode = 1;
  } else console.log('site:check: ок');
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  main(process.argv.slice(2));
}
