import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { anchorsOf, checkAll, checkPair, normalizeCode, parseDoc, slugify } from './docs-check.mjs';

const script = fileURLToPath(new URL('./docs-check.mjs', import.meta.url));

/** Временный корень с файлами { путь: содержимое }. */
function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'docs-check-'));
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), text);
  }
  return root;
}

const RU = `**Русский** · [English](guide.en.md)

# Руководство

## Установка

Запустите:

\`\`\`bash
# поднять стек
docker compose up -d   # фоном
scripts/restore.sh backups/<каталог>
\`\`\`

См. [«Установка»](#установка) и [ключи](other.md#ключи).
`;

const EN = `[Русский](guide.md) · **English**

# Guide

## Installation

Run:

\`\`\`bash
# start the stack
docker compose up -d   # in background
scripts/restore.sh backups/<directory>
\`\`\`

See ["Installation"](#installation) and [keys](other.en.md#keys).
`;

const OTHER = {
  'other.md': '**Русский** · [English](other.en.md)\n\n# Ключи\n',
  'other.en.md': '[Русский](other.md) · **English**\n\n# Keys\n',
};

const ok = (files) => tree({ 'guide.md': RU, 'guide.en.md': EN, ...OTHER, ...files });

test('совпадающая пара проходит', () => {
  assert.deepEqual(checkPair(ok({}), 'guide.md'), []);
});

test('нет английского файла', () => {
  const root = tree({ 'guide.md': RU });
  const out = checkPair(root, 'guide.md').join('\n');
  assert.match(out, /guide\.en\.md: нет файла/);
  // Ссылки русского документа проверяются и без пары: other.md в этом дереве нет.
  assert.match(out, /guide\.md:\d+: нет файла other\.md/);
});

test('нет или неверен переключатель', () => {
  const root = ok({ 'guide.en.md': EN.replace('[Русский](guide.md) · **English**', '# Guide') });
  assert.match(checkPair(root, 'guide.md').join('\n'), /guide\.en\.md:1: первая строка/);
  const root2 = ok({ 'guide.md': RU.replace('(guide.en.md)', '(guide-en.md)') });
  assert.match(checkPair(root2, 'guide.md').join('\n'), /guide\.md:1: первая строка/);
});

test('лишний или пропущенный заголовок', () => {
  const root = ok({ 'guide.en.md': EN.replace('## Installation', '## Installation\n\n## Extra') });
  assert.match(checkPair(root, 'guide.md').join('\n'), /заголовки расходятся/);
  const root2 = ok({ 'guide.en.md': EN.replace('## Installation\n', '') });
  assert.match(checkPair(root2, 'guide.md').join('\n'), /заголовки расходятся/);
});

test('другой уровень заголовка', () => {
  const root = ok({ 'guide.en.md': EN.replace('## Installation', '### Installation') });
  const out = checkPair(root, 'guide.md').join('\n');
  assert.match(out, /guide\.md:5: .*##/);
  assert.match(out, /guide\.en\.md:5: .*###/);
});

test('лишний блок кода', () => {
  const root = ok({ 'guide.en.md': EN + '\n```sh\nls\n```\n' });
  assert.match(checkPair(root, 'guide.md').join('\n'), /блоков кода: 1 и 2/);
});

test('изменена команда в блоке — ошибка', () => {
  const root = ok({ 'guide.en.md': EN.replace('up -d   #', 'up   #') });
  const out = checkPair(root, 'guide.md').join('\n');
  assert.match(out, /блок кода 1 расходится/);
  assert.match(out, /guide\.md:11/);
  assert.match(out, /guide\.en\.md:11/);
});

test('изменены только комментарии и заполнители — не ошибка', () => {
  assert.deepEqual(checkPair(ok({}), 'guide.md'), []);
  assert.deepEqual(
    normalizeCode([
      { n: 1, text: '  # комментарий' },
      { n: 2, text: '// ещё' },
      { n: 3, text: 'a=1 # хвост  ' },
      { n: 4, text: 'cat <файл> <<EOF' },
      { n: 5, text: 'curl http://x/y' },
    ]).map((l) => l.text),
    ['a=1', 'cat <> <<EOF', 'curl http://x/y'],
  );
});

test('ссылка на несуществующий файл и якорь', () => {
  const root = ok({ 'guide.en.md': EN.replace('other.en.md#keys', 'missing.md#keys') });
  assert.match(checkPair(root, 'guide.md').join('\n'), /guide\.en\.md:\d+: нет файла missing\.md/);
  const root2 = ok({ 'guide.en.md': EN.replace('(#installation)', '(#install)') });
  assert.match(
    checkPair(root2, 'guide.md').join('\n'),
    /guide\.en\.md:\d+: нет заголовка #install/,
  );
  const root3 = ok({ 'guide.md': RU.replace('(#установка)', '(#устан)') });
  assert.match(checkPair(root3, 'guide.md').join('\n'), /guide\.md:\d+: нет заголовка #устан/);
});

test('якорь повторяющегося заголовка получает -1', () => {
  const { headings } = parseDoc('# A\n\n## Шаги\n\n## Шаги\n');
  assert.deepEqual([...anchorsOf(headings)], ['a', 'шаги', 'шаги-1']);
});

test('якоря как у GitHub', () => {
  assert.equal(slugify('Обновление с 1.x'), 'обновление-с-1x');
  assert.equal(slugify('Параметр «SQL-список»'), 'параметр-sql-список');
  assert.equal(slugify('Вход через LDAP/Active Directory'), 'вход-через-ldapactive-directory');
  assert.equal(slugify('Графики ECharts в `шаблонах`'), 'графики-echarts-в-шаблонах');
  assert.equal(slugify('Язык — [отчёта](x.md)'), 'язык--отчёта');
  assert.equal(slugify('snake_case и Ёлка'), 'snake_case-и-ёлка');
});

test('# внутри блока кода — не заголовок', () => {
  const { headings, blocks } = parseDoc('# A\n\n```bash\n# комментарий\n```\n');
  assert.equal(headings.length, 1);
  assert.equal(blocks.length, 1);
});

test('блок из 4 кавычек и ~~~ закрывается только своим маркером', () => {
  const { blocks, headings } = parseDoc('````md\n```js\n# x\n```\n````\n\n~~~\n```\n~~~\n# H\n');
  assert.equal(blocks.length, 2);
  assert.deepEqual(
    blocks[0].lines.map((l) => l.text),
    ['```js', '# x', '```'],
  );
  assert.equal(headings.length, 1);
});

test('ссылка внутри инлайн-кода не проверяется', () => {
  const { links } = parseDoc('Пример: `[a](missing.md)` и [b](real.md).\n');
  assert.deepEqual(
    links.map((l) => l.target),
    ['real.md'],
  );
});

test('CRLF разбирается как LF', () => {
  const lf = parseDoc('# A\n\n```sh\nls # x\n```\n[b](#a)\n');
  const crlf = parseDoc('# A\r\n\r\n```sh\r\nls # x\r\n```\r\n[b](#a)\r\n');
  assert.deepEqual(crlf.headings, lf.headings);
  assert.deepEqual(crlf.blocks, lf.blocks);
  assert.deepEqual(crlf.links, lf.links);
});

test('внешние ссылки и почта не проверяются', () => {
  const { links } = parseDoc('[a](https://x.test/y) [b](mailto:a@b.c) [c](./z.md)\n');
  assert.deepEqual(
    links.map((l) => l.target),
    ['./z.md'],
  );
});

test('checkAll проходит по списку пар', () => {
  const root = ok({});
  assert.deepEqual(checkAll(root, ['guide.md', 'other.md']), []);
});

test('запуск: код выхода и --only', () => {
  const root = ok({ 'guide.en.md': EN.replace('## Installation', '### Installation') });
  const bad = spawnSync('node', [script, '--root', root, '--only', 'guide.md'], {
    encoding: 'utf8',
  });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /guide\.md:5/);
  const good = spawnSync('node', [script, '--root', root, '--only', 'other.md'], {
    encoding: 'utf8',
  });
  assert.equal(good.status, 0, good.stderr);
});
