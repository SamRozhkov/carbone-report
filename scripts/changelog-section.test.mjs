import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./changelog-section.mjs', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'changelog-'));

const sample = `# Журнал изменений

## [2.1.0] — 2026-10-10

### Добавлено

- версия сборки

## [2.0.0] — 2026-10-09

### Изменено

- встроенная сборка Carbone

## [1.0.0] — 2026-10-01

### Добавлено

- первый выпуск

[2.1.0]: https://example.test/compare/v2.0.0...v2.1.0
[2.0.0]: https://example.test/compare/v1.0.0...v2.0.0
[1.0.0]: https://example.test/releases/tag/v1.0.0
`;

function run(content, ...args) {
  const file = join(dir, `c-${Math.random().toString(36).slice(2)}.md`);
  writeFileSync(file, content);
  return spawnSync('node', [script, ...args, '--file', file], { encoding: 'utf8' });
}

test('раздел средней версии без заголовка и соседних разделов', () => {
  const r = run(sample, '2.0.0');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '### Изменено\n\n- встроенная сборка Carbone\n');
});

test('последняя версия (первая в файле) не захватывает чужие разделы', () => {
  const r = run(sample, '2.1.0');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '### Добавлено\n\n- версия сборки\n');
});

test('самая старая версия перед блоком ссылок — ссылки не входят', () => {
  const r = run(sample, '1.0.0');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '### Добавлено\n\n- первый выпуск\n');
  assert.ok(!r.stdout.includes('https://'));
});

test('версия с префиксом v допустима', () => {
  assert.equal(run(sample, 'v2.0.0').status, 0);
});

test('точка в версии не работает как любой символ', () => {
  assert.equal(run(sample, '2x0.0').status, 1);
});

test('нет версии — код 1 и сообщение', () => {
  const r = run(sample, '9.9.9');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /в CHANGELOG\.md нет раздела 9\.9\.9/);
  assert.equal(r.stdout, '');
});

test('раздел без текста — код 1', () => {
  const r = run('## [1.0.0] — 2026-10-01\n\n## [0.9.0] — 2026-09-01\n\n- что-то\n', '1.0.0');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /пуст/);
});

test('пустой последний раздел перед ссылками — код 1', () => {
  const r = run('## [1.0.0] — 2026-10-01\n\n[1.0.0]: https://example.test/x\n', '1.0.0');
  assert.equal(r.status, 1);
});

test('без версии в аргументах — код 2', () => {
  const r = spawnSync('node', [script], { encoding: 'utf8' });
  assert.equal(r.status, 2);
});
