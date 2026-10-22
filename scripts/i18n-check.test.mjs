import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const script = join(root, 'scripts/i18n-check.ts');
const tsx = join(root, 'node_modules/.bin/tsx');
const LOCALES = ['ru', 'en', 'es', 'pt-BR', 'fr', 'de', 'zh-CN'];
const base = mkdtempSync(join(tmpdir(), 'i18n-check-'));
// Пространства имён — как в репозитории (NAMESPACES): каждое должно быть в наборе, иначе «нет файла».
const NAMESPACES = readdirSync(join(root, 'packages/shared/src/i18n/ru')).map((f) =>
  f.replace(/\.json$/, ''),
);
test.after(() => rmSync(base, { recursive: true, force: true }));

/** Корректный набор каталогов: формы множественного числа — по CLDR каждого языка. */
function validCatalogs() {
  const out = {};
  for (const l of LOCALES) {
    const common = { title: 'Отчёт {{name}}', menu: { open: 'Открыть' } };
    for (const c of new Intl.PluralRules(l).resolvedOptions().pluralCategories)
      common[`items_${c}`] = `{{count}} ${c}`;
    out[l] = Object.fromEntries(NAMESPACES.map((ns) => [ns, {}]));
    Object.assign(out[l], {
      common,
      errors: { notFound: { template: 'нет шаблона {{id}}' } },
      validation: {},
    });
  }
  return out;
}

/** Пишет каталоги во временный каталог и запускает проверку на нём. */
function run(mutate = () => {}) {
  const cat = validCatalogs();
  mutate(cat);
  const dir = mkdtempSync(join(base, 'c-'));
  for (const [l, nss] of Object.entries(cat)) {
    mkdirSync(join(dir, l));
    for (const [ns, data] of Object.entries(nss))
      if (data !== undefined) writeFileSync(join(dir, l, `${ns}.json`), JSON.stringify(data));
  }
  return spawnSync(tsx, [script, dir], { encoding: 'utf8' });
}

test('корректный набор — без ошибок', () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /в порядке/);
});

test('каталоги репозитория проходят проверку', () => {
  const r = spawnSync(tsx, [script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
});

test('недостающий ключ', () => {
  const r = run((c) => delete c.en.common.menu.open);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /en\/common: нет ключа menu\.open/);
});

test('лишний ключ', () => {
  const r = run((c) => (c.de.errors.extra = 'Extra'));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /de\/errors: лишний ключ extra/);
});

test('разные параметры', () => {
  const r = run((c) => (c.fr.common.title = 'Rapport {{title}}'));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /fr\/common: title — параметры \{title\}, в ru \{name\}/);
});

test('параметры сравниваются как множества: повтор параметра — не ошибка', () => {
  const r = run((c) => (c.de.common.title = 'Bericht {{name}} ({{name}})'));
  assert.equal(r.status, 0, r.stderr);
});

test('параметр без экранирования {{- name}} — тот же name', () => {
  const r = run((c) => {
    c.en.common.title = 'Report {{- name}}';
    c.fr.common.title = 'Rapport {{-name}}';
  });
  assert.equal(r.status, 0, r.stderr);
});

test('{{- other}} вместо {{name}} — ошибка', () => {
  const r = run((c) => (c.es.common.title = 'Informe {{- other}}'));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /es\/common: title — параметры \{other\}, в ru \{name\}/);
});

test('недостающий параметр при повторе другого — ошибка', () => {
  const r = run((c) => {
    for (const l of LOCALES) c[l].common.pair = '{{a}} {{b}}';
    c.de.common.pair = '{{a}} {{a}}';
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /de\/common: pair — параметры \{a\}, в ru \{a, b\}/);
});

test('параметры форм множественного числа сверяются с ru _other', () => {
  const r = run((c) => (c.es.common.items_many = 'muchos'));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /es\/common: items_many — параметры \{\}, в ru \{count\}/);
});

test('нет формы _few у ru', () => {
  const r = run((c) => delete c.ru.common.items_few);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ru\/common: у ключа items нет формы _few/);
});

test('нет формы _many у fr', () => {
  const r = run((c) => delete c.fr.common.items_many);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /fr\/common: у ключа items нет формы _many/);
});

test('лишняя форма множественного числа', () => {
  const r = run((c) => (c['zh-CN'].common.items_one = '{{count}} one'));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /zh-CN\/common: у ключа items лишняя форма _one/);
});

test('пустая строка', () => {
  const r = run((c) => (c.ru.common.menu.open = ' '));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ru\/common: пустая строка menu\.open/);
});

test('нет файла пространства имён', () => {
  const r = run((c) => (c['pt-BR'].validation = undefined));
  assert.equal(r.status, 1);
  assert.match(r.stderr, /pt-BR\/validation: нет файла validation\.json/);
});

test('вложенность глубже двух уровней', () => {
  const r = run((c) => {
    for (const l of LOCALES) c[l].common.menu.sub = { deep: 'x' };
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /ru\/common: ключ menu\.sub вложен глубже двух уровней/);
});

/** Пишет исходники веба во временный каталог: { 'путь/файл.tsx': 'код' }. */
function webSrc(files) {
  const dir = mkdtempSync(join(base, 'web-'));
  for (const [rel, code] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), code);
  }
  return dir;
}

/** Каталоги — корректный набор, исходники веба — из webSrc. */
function runWeb(files) {
  const cat = validCatalogs();
  const dir = mkdtempSync(join(base, 'c-'));
  for (const [l, nss] of Object.entries(cat)) {
    mkdirSync(join(dir, l));
    for (const [ns, data] of Object.entries(nss))
      writeFileSync(join(dir, l, `${ns}.json`), JSON.stringify(data));
  }
  return spawnSync(tsx, [script, dir, `--web-src=${webSrc(files)}`], { encoding: 'utf8' });
}

test('кириллица в коде веба: текст JSX, строка и шаблонная строка', () => {
  const r = runWeb({
    'pages/Page.tsx': [
      'export const Page = () => (',
      '  <div title="Заголовок">',
      '    Текст страницы',
      '  </div>',
      ');',
      'export const s = `Шаблон ${1}`;',
      '',
    ].join('\n'),
  });
  assert.equal(r.status, 1);
  const hits = r.stderr.split('\n').filter((l) => l.includes('кириллица в коде веба'));
  assert.equal(hits.length, 3, r.stderr);
  assert.match(r.stderr, /Page\.tsx:2: Заголовок/);
  assert.match(r.stderr, /Page\.tsx:3: Текст страницы/);
  assert.match(r.stderr, /Page\.tsx:6: Шаблон/);
});

test('кириллица в коде веба: справка, тесты, test/ и комментарии не проверяются', () => {
  const r = runWeb({
    'pages/admin/help/Help.tsx': 'export const h = <p>Справка</p>;\n',
    'pages/Page.test.tsx': "it('строка', () => {});\n",
    'test/fixtures.ts': "export const name = 'Отчёт';\n",
    'lib/ok.ts': [
      '// Комментарий по-русски',
      '/** И документирующий комментарий. */',
      "export const label = 'Report';",
      '',
    ].join('\n'),
  });
  assert.equal(r.status, 0, r.stderr);
});
