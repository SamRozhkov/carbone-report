import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkSite, MAX_SHOT, SHOTS } from './site-check.mjs';

const script = fileURLToPath(new URL('./site-check.mjs', import.meta.url));

const roots = [];
after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

const img = (prefix, name) =>
  `<a href="${prefix}shots/${name}.png"><img src="${prefix}shots/${name}.png" alt="Экран ${name}" width="1440" height="900" loading="lazy"></a>`;

function page(lang, { shots = SHOTS, nav, version = '2.18.0', extra = '', imgFor } = {}) {
  const prefix = lang === 'ru' ? '' : '../';
  const other = lang === 'ru' ? 'en/index.html' : '../index.html';
  const navHtml = nav ?? `<nav class="lang"><b>Lang</b> · <a href="${other}">Other</a></nav>`;
  const imgs = shots.map((s) => (imgFor ?? img)(prefix, `${lang}/${s}`)).join('\n');
  return `<!doctype html>
<html lang="${lang}">
<head><meta charset="utf-8"><link rel="stylesheet" href="${prefix}style.css"><title>T</title></head>
<body>
${navHtml}
<main>
${imgs}
${extra}
</main>
<footer><span data-version="${version}">${version}</span></footer>
</body>
</html>
`;
}

/** Временный репозиторий: корректный сайт, поверх — files ({ путь: содержимое | null }). */
function repo(files = {}) {
  const root = mkdtempSync(join(tmpdir(), 'site-check-'));
  roots.push(root);
  const base = {
    'CHANGELOG.md': '# Журнал\n\n## [2.18.0] — 2026-10-27\n\n## [2.17.0] — 2026-10-26\n',
    'site/index.html': page('ru'),
    'site/en/index.html': page('en'),
    'site/style.css': 'body{margin:0}\n',
  };
  for (const lang of ['ru', 'en'])
    for (const s of SHOTS) base[`site/shots/${lang}/${s}.png`] = Buffer.alloc(1000);
  for (const [p, content] of Object.entries({ ...base, ...files })) {
    if (content === null) continue;
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), content);
  }
  return root;
}

const has = (errors, re) =>
  assert.ok(
    errors.some((e) => re.test(e)),
    errors.join('\n') || '(нет ошибок)',
  );

test('корректный сайт проходит', () => {
  assert.deepEqual(checkSite(repo()), []);
});

test('нет английской страницы', () => {
  has(checkSite(repo({ 'site/en/index.html': null })), /site\/en\/index\.html: нет файла/);
});

test('нет переключателя языка или неверная ссылка в нём', () => {
  has(checkSite(repo({ 'site/index.html': page('ru', { nav: '<p>x</p>' }) })), /переключатель/);
  has(
    checkSite(
      repo({
        'site/index.html': page('ru', {
          nav: '<nav class="lang"><a href="index.html">x</a></nav>',
        }),
      }),
    ),
    /переключатель/,
  );
});

test('ссылка на отсутствующий снимок', () => {
  const r = repo({ 'site/shots/ru/users.png': null });
  has(checkSite(r), /shots\/ru\/users\.png/);
});

test('снимок без ссылки на странице', () => {
  const shots = SHOTS.filter((s) => s !== 'run');
  has(checkSite(repo({ 'site/index.html': page('ru', { shots }) })), /не показан на странице: run/);
});

test('разный набор снимков ru и en', () => {
  const r = repo({ 'site/shots/en/extra.png': Buffer.alloc(10) });
  has(checkSite(r), /shots\/en: лишний снимок extra\.png/);
});

test('чужой язык: en-страница показывает русский снимок', () => {
  const imgFor = (prefix, name) => img(prefix, name.replace(/^en\//, 'ru/'));
  has(checkSite(repo({ 'site/en/index.html': page('en', { imgFor }) })), /снимок другого языка/);
});

test('корневая ссылка /x', () => {
  const extra = '<a href="/x">x</a><img src="/shots/ru/run.png" alt="a" width="1" height="1">';
  const errors = checkSite(repo({ 'site/index.html': page('ru', { extra }) }));
  has(errors, /ссылка \/x ведёт в корень домена/);
  has(errors, /ссылка \/shots\/ru\/run\.png ведёт в корень домена/);
});

test('чужой язык: <a href> на снимок другого языка', () => {
  const extra = '<a href="../shots/ru/run.png">x</a>';
  has(checkSite(repo({ 'site/en/index.html': page('en', { extra }) })), /снимок другого языка/);
});

test('неверное процентное кодирование в ссылке', () => {
  const extra = '<a href="a%E0%A4%A.html">x</a>';
  has(
    checkSite(repo({ 'site/index.html': page('ru', { extra }) })),
    /неверная ссылка a%E0%A4%A\.html/,
  );
});

test('выход за site/', () => {
  const extra = '<a href="../README.md">README</a>';
  has(checkSite(repo({ 'site/index.html': page('ru', { extra }) })), /за пределы site/);
});

test('img без alt, width или height', () => {
  const extra = '<img src="shots/ru/run.png">';
  const errors = checkSite(repo({ 'site/index.html': page('ru', { extra }) }));
  has(errors, /нет alt/);
  has(errors, /нет width/);
  has(errors, /нет height/);
});

test('превышение размера снимка', () => {
  has(
    checkSite(repo({ 'site/shots/ru/run.png': Buffer.alloc(MAX_SHOT + 1) })),
    /run\.png: больше 600 КБ/,
  );
});

test('внешние ресурсы', () => {
  const extra =
    '<script src="a.js"></script><link rel="stylesheet" href="https://fonts.example/x.css"><img src="https://x.example/a.png" alt="a" width="1" height="1">';
  const errors = checkSite(repo({ 'site/index.html': page('ru', { extra }) }));
  has(errors, /<script>/);
  has(errors, /внешний ресурс https:\/\/fonts\.example/);
  has(errors, /внешний ресурс https:\/\/x\.example/);
});

test('версия в команде установки устарела, а в подвале верная', () => {
  const extra =
    '<p data-version="2.18.0">2.18.0</p><pre>helm install … --version <span data-version="2.17.0">2.17.0</span></pre>';
  has(checkSite(repo({ 'site/index.html': page('ru', { extra }) })), /версия 2\.17\.0.*2\.18\.0/);
});

test('версия не совпадает с CHANGELOG', () => {
  has(
    checkSite(repo({ 'site/index.html': page('ru', { version: '2.17.0' }) })),
    /версия 2\.17\.0.*2\.18\.0/,
  );
});

test('CLI: ошибки → код 1, неверный аргумент → код 2', () => {
  const bad = repo({ 'site/en/index.html': null });
  const r1 = spawnSync(process.execPath, [script, '--root', bad], { encoding: 'utf8' });
  assert.equal(r1.status, 1);
  assert.match(r1.stdout + r1.stderr, /нет файла/);
  const r0 = spawnSync(process.execPath, [script, '--root', repo()], { encoding: 'utf8' });
  assert.equal(r0.status, 0, r0.stdout + r0.stderr);
  const r2 = spawnSync(process.execPath, [script, '--bogus'], { encoding: 'utf8' });
  assert.equal(r2.status, 2);
});
