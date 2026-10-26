# 2.17.0: документация на английском — план реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** английские версии четырёх документов для администраторов и проверка `pnpm docs:check`, которая не даёт русской и английской версиям разойтись.

**Architecture:** скрипт на чистом Node `scripts/docs-check.mjs` разбирает markdown (заголовки, блоки кода, ссылки) и сверяет пары `X.md` ↔ `X.en.md`; тесты — `node --test`. Английские файлы лежат рядом с русскими. Код приложения не меняется.

**Tech Stack:** Node 22 (ESM, `node:test`), markdown, pnpm, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-02-carbone-reports-design.md`, §48 (и §44 — этапы локализации).

## Global Constraints

- Русский — источник; английские файлы: `README.en.md`, `docs/localization.en.md`, `docs/operations/gost-signature.en.md`, `docs/operations/keycloak.en.md`.
- Не переводятся: `CHANGELOG.md`, `docs/superpowers/`, `apps/api/test/fixtures/*/README.md`, `cades/README.md`, `packages/carbone/`, `LICENSE.md`, `NOTICE.md`.
- Первая строка документа пары: в русском `**Русский** · [English](<имя>.en.md)`, в английском `[Русский](<имя>.md) · **English**` (`<имя>` — имя файла без каталога, файлы пары лежат в одном каталоге).
- В блоках кода переводятся только комментарии (`#`, `//`) и заполнители `<…>`; код, команды, имена файлов, переменных, ключей, значений, URL — не меняются. Блоки, где русский текст — пример (формы множественного числа в `docs/localization.md`), не меняются.
- Подписи интерфейса — дословно из `packages/shared/src/i18n/en/*.json`, в кавычках "…"; подписи, которой нет в каталоге, переводятся один раз и одинаково везде.
- Ссылки на документы без пары (`CHANGELOG.md`, спецификация) остаются и помечаются «(in Russian)».
- Порядок разделов, уровни заголовков, таблицы и блоки кода совпадают с русским документом один к одному.
- `scripts/docs-check.mjs` — без зависимостей; ошибки — строками `файл:строка: что не так`, код выхода 1.
- Не читать и не печатать `.env` и `certs/`. Коммиты заканчиваются абзацем:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` и `Claude-Session: https://claude.ai/code/session_01QhpYjvmQgUdZAFnqrogAEB`.
- Node: `export PATH=$HOME/.nvm/versions/node/v22.17.0/bin:$PATH`. В zsh глобы — в кавычках.

## Review Focus

1. Строки `# …` внутри блоков кода (комментарии bash) не считаются заголовками — тест в Task 1.
2. Блок, открытый ```` ```` ```` (4 обратных кавычки) или `~~~`, с ```` ``` ```` внутри, закрывается только своим маркером — тест в Task 1.
3. Ссылка внутри инлайн-кода (`` `[a](b)` ``) не проверяется — тест в Task 1.
4. Файлы с переводами строк CRLF разбираются так же, как с LF — тест в Task 1.
5. Якорь заголовка с инлайн-кодом, ссылкой, `«»`, `—`, `/`, `.` считается как у GitHub (например, «Обновление с 1.x» → `обновление-с-1x`) — тест в Task 1.

---

### Task 1: скрипт `docs-check` и тесты

**Files:**
- Create: `scripts/docs-check.mjs`
- Create: `scripts/docs-check.test.mjs`
- Modify: `package.json` (скрипт `docs:check`)

**Interfaces:**
- Produces: команда `pnpm docs:check` (= `node scripts/docs-check.mjs`), флаги `--root <каталог>` (корень репозитория, по умолчанию — родитель `scripts/`) и `--only <путь к русскому файлу>` (проверить одну пару); экспорт `DOC_PAIRS`, `enPath`, `switcherLine`, `parseDoc`, `slugify`, `anchorsOf`, `normalizeCode`, `checkPair`, `checkLinks`, `checkAll`.

- [ ] **Step 1: Написать тесты** — `scripts/docs-check.test.mjs`:

```js
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
  assert.match(checkPair(root2, 'guide.md').join('\n'), /guide\.en\.md:\d+: нет заголовка #install/);
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
  const bad = spawnSync('node', [script, '--root', root, '--only', 'guide.md'], { encoding: 'utf8' });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /guide\.md:5/);
  const good = spawnSync('node', [script, '--root', root, '--only', 'other.md'], { encoding: 'utf8' });
  assert.equal(good.status, 0, good.stderr);
});
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `node --test scripts/docs-check.test.mjs`
Expected: FAIL — `Cannot find module …/docs-check.mjs`.

- [ ] **Step 3: Написать `scripts/docs-check.mjs`**

```js
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
    if (!cache.get(targetRel).has(anchor)) errors.push(`${rel}:${line}: нет заголовка #${anchor} в ${targetRel}`);
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
    const show = (rel, h) => (h ? `${rel}:${h.line}: ${'#'.repeat(h.level)} ${h.text}` : `${rel}: заголовка нет`);
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
        const where = (rel, l, start) => `${rel}:${l ? l.n : start}: ${l ? l.text : '(конец блока)'}`;
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

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main(process.argv.slice(2));
}
```

- [ ] **Step 4: Тесты проходят**

Run: `node --test scripts/docs-check.test.mjs`
Expected: PASS, все тесты. Если тест не проходит, исправлять скрипт, а не ослаблять тест; если тест противоречит §48.3 — сообщить в отчёте.

- [ ] **Step 5: Скрипт в `package.json`** — после строки `"i18n:check": …`:

```json
    "docs:check": "node scripts/docs-check.mjs",
```

- [ ] **Step 6: Прогон по репозиторию**

Run: `pnpm docs:check`
Expected: код выхода 1; ошибки `…en.md: нет файла` для 4 пар (английских файлов ещё нет) и, возможно, сломанные ссылки в русских документах. Список ошибок ссылок в **русских** файлах записать в отчёт — их исправляет Task 2. В CI шаг ещё не добавлять (Task 7).

- [ ] **Step 7: Проверки и коммит**

Run: `pnpm test:scripts && pnpm lint && pnpm exec prettier --check scripts package.json`
Expected: PASS (если prettier ругается на новые файлы — `pnpm exec prettier --write scripts/docs-check.mjs scripts/docs-check.test.mjs` и повторить тесты).

```bash
git add scripts/docs-check.mjs scripts/docs-check.test.mjs package.json
git commit -m "feat(docs): проверка пар документации docs:check (§48.3)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QhpYjvmQgUdZAFnqrogAEB"
```

---

### Task 2: русские документы — переключатель, раздел «Документация», ссылки

**Files:**
- Modify: `README.md`, `docs/localization.md`, `docs/operations/gost-signature.md`, `docs/operations/keycloak.md`

**Interfaces:**
- Consumes: `node scripts/docs-check.mjs --only <файл>` из Task 1 (ошибки ссылок в русском файле).
- Produces: окончательные русские тексты, которые переводят Tasks 3–6.

- [ ] **Step 1: Переключатель.** Первой строкой каждого из 4 файлов вставить переключатель и пустую строку после него:
  - `README.md`: `**Русский** · [English](README.en.md)`
  - `docs/localization.md`: `**Русский** · [English](localization.en.md)`
  - `docs/operations/gost-signature.md`: `**Русский** · [English](gost-signature.en.md)`
  - `docs/operations/keycloak.md`: `**Русский** · [English](keycloak.en.md)`

- [ ] **Step 2: `docs/localization.md`, список этапов** — пункт 4 заменить на:

```markdown
4. Документация на английском — 2.17.0 (раздел «Документация»).
```

- [ ] **Step 3: `docs/localization.md`, новый раздел** — в конец файла:

```markdown
## Документация

Документы для тех, кто ставит и сопровождает систему, есть на русском и английском (спецификация, §48). Русский — источник; английская версия лежит рядом с суффиксом `.en.md`:

| Русский | Английский |
| --- | --- |
| `README.md` | `README.en.md` |
| `docs/localization.md` | `docs/localization.en.md` |
| `docs/operations/gost-signature.md` | `docs/operations/gost-signature.en.md` |
| `docs/operations/keycloak.md` | `docs/operations/keycloak.en.md` |

`CHANGELOG.md`, `docs/superpowers/` и README тестовых фикстур не переводятся. Новый документ для администраторов добавляется в `DOC_PAIRS` (`scripts/docs-check.mjs`) вместе с английской версией.

Правила перевода:

- первая строка — переключатель языка: `**Русский** · [English](<имя>.en.md)` в русском, `[Русский](<имя>.md) · **English**` в английском;
- в блоках кода переводятся только комментарии и заполнители `<…>`; команды, имена файлов, переменных, ключей и значения не меняются;
- подписи интерфейса берутся дословно из каталогов `en` (`packages/shared/src/i18n/en/*.json`);
- ссылки из английского документа ведут на английские пары; ссылки на документы без пары помечаются «(in Russian)»;
- разделы, уровни заголовков, таблицы и блоки кода идут в том же порядке, что в русском документе.

Правка русского документа сопровождается правкой английского в том же PR. `pnpm docs:check` (шаг CI «Проверки») сверяет пары: переключатель, уровни заголовков, блоки кода с точностью до комментариев и заполнителей, а также существование файлов и якорей у относительных ссылок в обеих версиях.
```

- [ ] **Step 4: `README.md`, раздел «Разработка интерфейса»** — после строки «Тесты интерфейса: …» добавить абзац:

```markdown
Документация есть на русском и английском (`README.en.md`, `docs/**/*.en.md`); правка русского документа сопровождается правкой английского, пары сверяет `pnpm docs:check` (подробно — [`docs/localization.md`](docs/localization.md#документация)).
```

- [ ] **Step 5: Сломанные ссылки.** Для каждого из 4 файлов:

Run: `node scripts/docs-check.mjs --only README.md` (и так для остальных трёх)
Expected: остаются только ошибки `….en.md: нет файла`. Ошибку ссылки в русском файле (`README.md:N: нет заголовка #…` или `нет файла …`) исправить в самой ссылке так, чтобы она вела на нужный раздел; заголовки не переименовывать.

- [ ] **Step 6: Форматирование и коммит**

Run: `pnpm exec prettier --check README.md`
Expected: PASS (`docs/` в `.prettierignore`).

```bash
git add README.md docs/localization.md docs/operations/gost-signature.md docs/operations/keycloak.md
git commit -m "docs: переключатель языка и раздел «Документация» (§48.4)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QhpYjvmQgUdZAFnqrogAEB"
```

---

### Task 3: `docs/operations/keycloak.en.md`

**Files:**
- Create: `docs/operations/keycloak.en.md`

**Interfaces:**
- Consumes: `docs/operations/keycloak.md` после Task 2; `node scripts/docs-check.mjs --only docs/operations/keycloak.md`; каталоги `packages/shared/src/i18n/en/*.json` (подписи интерфейса; русские — в `…/ru/*.json` с теми же ключами).

- [ ] **Step 1: Перевести.** Прочитать русский файл целиком и написать английский по правилам Global Constraints. Первая строка — `[Русский](keycloak.md) · **English**`. Подпись интерфейса из русского текста найти в `ru/*.json` (`grep -rn '<подпись>' packages/shared/src/i18n/ru`) и взять значение того же ключа из `en/*.json`. Ссылки на `README.md#<якорь>` заменить на `../../README.en.md#<английский якорь>` — якорь строится из английского заголовка, который получит `README.en.md` (Task 6): перевод заголовка README брать согласованно — английский заголовок раздела README = перевод русского; если не уверены в формулировке, записать в отчёт, какие якоря README использованы (Task 6 сверит их).

- [ ] **Step 2: Проверка пары**

Run: `node scripts/docs-check.mjs --only docs/operations/keycloak.md`
Expected: нет ошибок, кроме `нет файла …README.en.md` / `нет заголовка … README.en.md`, если ссылка ведёт в ещё не созданный `README.en.md` (такие ошибки перечислить в отчёте; их снимет Task 6).

- [ ] **Step 3: Коммит**

```bash
git add docs/operations/keycloak.en.md
git commit -m "docs(en): Keycloak (§48)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QhpYjvmQgUdZAFnqrogAEB"
```

---

### Task 4: `docs/operations/gost-signature.en.md`

**Files:**
- Create: `docs/operations/gost-signature.en.md`

**Interfaces:**
- Consumes: `docs/operations/gost-signature.md` после Task 2; `node scripts/docs-check.mjs --only docs/operations/gost-signature.md`; каталоги `en`/`ru`.

- [ ] **Step 1: Перевести.** Как в Task 3: первая строка — `[Русский](gost-signature.md) · **English**`; подписи интерфейса — по ключам каталогов (`signature`, `editor`, `common`); термины: ГОСТ → GOST, КриптоПро → CryptoPro, ЭП/электронная подпись → electronic signature, открепленная подпись `.sig` → detached signature (`.sig`). Ссылки на README — на `../../README.en.md#…` (см. Task 3).

- [ ] **Step 2: Проверка пары**

Run: `node scripts/docs-check.mjs --only docs/operations/gost-signature.md`
Expected: как в Task 3, Step 2.

- [ ] **Step 3: Коммит**

```bash
git add docs/operations/gost-signature.en.md
git commit -m "docs(en): подпись ГОСТ (§48)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QhpYjvmQgUdZAFnqrogAEB"
```

---

### Task 5: `docs/localization.en.md`

**Files:**
- Create: `docs/localization.en.md`

**Interfaces:**
- Consumes: `docs/localization.md` после Task 2; `node scripts/docs-check.mjs --only docs/localization.md`; каталоги `en`/`ru`.

- [ ] **Step 1: Перевести.** Первая строка — `[Русский](localization.md) · **English**`. Блоки кода с русскими строками-примерами (формы множественного числа `tooManyPasswords_*` и другие примеры русского каталога) не менять. Названия пространств имён, ключи, пути — как есть. Ссылки на спецификацию — с пометкой «(in Russian)».

- [ ] **Step 2: Проверка пары**

Run: `node scripts/docs-check.mjs --only docs/localization.md`
Expected: как в Task 3, Step 2.

- [ ] **Step 3: Коммит**

```bash
git add docs/localization.en.md
git commit -m "docs(en): локализация (§48)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QhpYjvmQgUdZAFnqrogAEB"
```

---

### Task 6: `README.en.md`

**Files:**
- Create: `README.en.md`
- Modify (только якоря ссылок на README, если расходятся): `docs/operations/keycloak.en.md`, `docs/operations/gost-signature.en.md`, `docs/localization.en.md`

**Interfaces:**
- Consumes: `README.md` после Task 2; отчёты Tasks 3–5 (какие якоря `README.en.md` они использовали); каталоги `en`/`ru`.

- [ ] **Step 1: Перевести.** Первая строка — `[Русский](README.md) · **English**`. Ссылки внутри README — на английские якоря этого же файла; на `docs/…` — на `.en.md`; на `CHANGELOG.md` и спецификацию — с «(in Russian)». Значок CI и ссылки `https://…` — без изменений. Подписи интерфейса и роли — из каталогов `en`.

- [ ] **Step 2: Форматирование**

Run: `pnpm exec prettier --write README.en.md && pnpm exec prettier --check README.md README.en.md`
Expected: PASS.

- [ ] **Step 3: Проверка всех пар**

Run: `pnpm docs:check`
Expected: `docs:check: пар проверено — 4`, код выхода 0. Ошибки якорей README в трёх других английских документах исправить в этих документах (заголовки README не подгонять под чужие ссылки, если перевод заголовка точнее).

- [ ] **Step 4: Коммит**

```bash
git add README.en.md docs/operations/keycloak.en.md docs/operations/gost-signature.en.md docs/localization.en.md
git commit -m "docs(en): README (§48)" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QhpYjvmQgUdZAFnqrogAEB"
```

---

### Task 7: CI и CHANGELOG 2.17.0

**Files:**
- Modify: `.github/workflows/ci.yml` (задание «Проверки», после `- run: pnpm i18n:check`)
- Modify: `CHANGELOG.md` (раздел `## [2.17.0]` над `## [2.16.0]`)

- [ ] **Step 1: Шаг CI** — после строки `      - run: pnpm i18n:check`:

```yaml
      - run: pnpm docs:check
```

- [ ] **Step 2: CHANGELOG** — над `## [2.16.0] — 2026-10-23`:

```markdown
## [2.17.0] — 2026-10-26

### Добавлено

- Документация на английском: `README.en.md`, `docs/localization.en.md`, `docs/operations/gost-signature.en.md`, `docs/operations/keycloak.en.md`; в начале каждого документа — переключатель языка. Русский остаётся источником.
- Проверка `pnpm docs:check` (шаг CI «Проверки»): у пар русского и английского документа совпадают заголовки и блоки кода, а относительные ссылки и якоря ведут на существующие файлы и разделы.

```

- [ ] **Step 3: Проверки**

Run: `pnpm docs:check && pnpm test:scripts && node scripts/changelog-section.mjs 2.17.0 >/dev/null && pnpm exec prettier --check . && pnpm lint`
Expected: всё PASS (ошибки lint только в git-игнорируемом `cades/cadesplugin_api.js` — локальный шум, его нет в CI).

- [ ] **Step 4: Коммит**

```bash
git add .github/workflows/ci.yml CHANGELOG.md
git commit -m "ci: docs:check; CHANGELOG 2.17.0" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01QhpYjvmQgUdZAFnqrogAEB"
```
