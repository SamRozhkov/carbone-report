#!/usr/bin/env node
// Печатает текст раздела версии из CHANGELOG.md (без заголовка).
// Использование: node scripts/changelog-section.mjs <версия> [--file <путь>]
// Нет раздела или он пуст — код выхода 1 и сообщение в stderr.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const defaultFile = fileURLToPath(new URL('../CHANGELOG.md', import.meta.url));

/** Раздел версии или null. Раздел кончается следующим «## » или блоком ссылок «[x]: https://…». */
export function extractSection(text, version) {
  const lines = text.split(/\r?\n/);
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const head = new RegExp(`^##\\s+\\[${escaped}\\](\\s|$)`);
  const start = lines.findIndex((l) => head.test(l));
  if (start === -1) return null;
  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i]) || /^\[[^\]]+\]:\s*\S/.test(lines[i])) break;
    body.push(lines[i]);
  }
  return body.join('\n').trim();
}

function main(argv) {
  let file = defaultFile;
  let version;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--file') file = argv[++i];
    else version = argv[i];
  }
  if (!version || !file) {
    console.error('Использование: changelog-section.mjs <версия> [--file <путь>]');
    return 2;
  }
  version = version.replace(/^v/, '');
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    console.error(`не удалось прочитать ${file}: ${e.message}`);
    return 1;
  }
  const section = extractSection(text, version);
  if (section === null) {
    console.error(`в CHANGELOG.md нет раздела ${version}`);
    return 1;
  }
  if (section === '') {
    console.error(`в CHANGELOG.md раздел ${version} пуст`);
    return 1;
  }
  console.log(section);
  return 0;
}

// realpath: при запуске по символической ссылке argv[1] не совпадает с путём модуля.
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  process.exitCode = main(process.argv.slice(2));
}
