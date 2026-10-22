// Проверка каталогов переводов (§44.6).
// Запуск: pnpm i18n:check            — каталоги packages/shared/src/i18n;
//         pnpm i18n:check <каталог> — другой каталог с теми же подкаталогами языков (тесты).
// Сверка с `ru` (источник): набор ключей, параметры {{…}}, формы множественного числа
// по CLDR, пустые строки. Ошибки выводятся списком, код выхода 1.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { LOCALES, NAMESPACES } from '@carbone-reports/shared/i18n';

/** Кириллица в строках кода веба (непереведённый текст, §44.6). */
const CHECK_WEB_CYRILLIC = true;
/** Кириллица в аргументах AppError и помощников ошибок API; включается в Task 3. */
const CHECK_API_ERRORS = true;

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SOURCE = 'ru';
const PLURAL_SUFFIX = /^(.+)_(zero|one|two|few|many|other)$/;
// {{name}}, {{name, format}} и {{- name}} (без экранирования) — параметр name.
const PARAM = /\{\{-?\s*([^\s},]+)[^}]*\}\}/g;
const CYRILLIC = /[Ѐ-ӿ]/;

type Flat = Map<string, string>;
/** Ключ каталога без суффикса множественного числа: обычная строка или набор форм. */
type Entry = { plain?: string; forms: Map<string, string> };

function flatten(
  obj: unknown,
  prefix: string,
  depth: number,
  out: Flat,
  errors: string[],
  where: string,
) {
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      if (depth >= 2) errors.push(`${where}: ключ ${key} вложен глубже двух уровней`);
      else flatten(v, key, depth + 1, out, errors, where);
    } else if (typeof v === 'string') out.set(key, v);
    else errors.push(`${where}: значение ключа ${key} — не строка`);
  }
}

function group(flat: Flat): Map<string, Entry> {
  const out = new Map<string, Entry>();
  const entry = (base: string) => {
    let e = out.get(base);
    if (!e) out.set(base, (e = { forms: new Map() }));
    return e;
  };
  for (const [key, value] of flat) {
    const m = PLURAL_SUFFIX.exec(key);
    if (m) entry(m[1]!).forms.set(m[2]!, value);
    else entry(key).plain = value;
  }
  return out;
}

const params = (s: string) => [...s.matchAll(PARAM)].map((m) => m[1]!).sort();
/** Параметры сравниваются как множества: повтор {{name}} в переводе допустим. */
const sameParams = (a: string[], b: string[]) => {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((p) => sb.has(p));
};
const show = (p: string[]) => `{${[...new Set(p)].join(', ')}}`;

function loadNamespace(dir: string, locale: string, ns: string, errors: string[]) {
  const where = `${locale}/${ns}`;
  const file = join(dir, locale, `${ns}.json`);
  if (!existsSync(file)) {
    errors.push(`${where}: нет файла ${ns}.json`);
    return undefined;
  }
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    errors.push(`${where}: неверный JSON (${(e as Error).message})`);
    return undefined;
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    errors.push(`${where}: каталог должен быть объектом`);
    return undefined;
  }
  const flat: Flat = new Map();
  flatten(json, '', 1, flat, errors, where);
  return group(flat);
}

/** Проверка одного языка против источника (для самого `ru` — только формы и пустые строки). */
function checkNamespace(
  locale: string,
  ns: string,
  entries: Map<string, Entry>,
  source: Map<string, Entry>,
  errors: string[],
) {
  const where = `${locale}/${ns}`;
  const categories = new Intl.PluralRules(locale).resolvedOptions().pluralCategories as string[];
  for (const key of source.keys()) if (!entries.has(key)) errors.push(`${where}: нет ключа ${key}`);
  for (const [key, e] of entries) {
    const src = source.get(key);
    if (!src) {
      errors.push(`${where}: лишний ключ ${key}`);
      continue;
    }
    for (const [form, value] of e.forms)
      if (!value.trim()) errors.push(`${where}: пустая строка ${key}_${form}`);
    if (e.plain !== undefined && !e.plain.trim()) errors.push(`${where}: пустая строка ${key}`);

    if (src.forms.size > 0) {
      if (e.plain !== undefined)
        errors.push(`${where}: ключ ${key} задан без формы множественного числа`);
      for (const c of categories)
        if (!e.forms.has(c)) errors.push(`${where}: у ключа ${key} нет формы _${c}`);
      for (const c of e.forms.keys())
        if (!categories.includes(c)) errors.push(`${where}: у ключа ${key} лишняя форма _${c}`);
      const expected = src.forms.get('other');
      if (expected === undefined) continue;
      for (const [form, value] of e.forms) {
        const p = params(value);
        if (!sameParams(p, params(expected)))
          errors.push(
            `${where}: ${key}_${form} — параметры ${show(p)}, в ${SOURCE} ${show(params(expected))}`,
          );
      }
    } else {
      for (const form of e.forms.keys())
        errors.push(`${where}: у ключа ${key} лишняя форма _${form} (в ${SOURCE} её нет)`);
      if (e.plain === undefined || src.plain === undefined) continue;
      const p = params(e.plain);
      if (!sameParams(p, params(src.plain)))
        errors.push(
          `${where}: ${key} — параметры ${show(p)}, в ${SOURCE} ${show(params(src.plain))}`,
        );
    }
  }
}

function checkCatalogs(dir: string): string[] {
  const errors: string[] = [];
  const present = readdirSync(dir).filter((d) => statSync(join(dir, d)).isDirectory());
  for (const d of present)
    if (!(LOCALES as readonly string[]).includes(d)) errors.push(`${d}: язык не из LOCALES`);
  const locales = LOCALES.filter((l) => {
    if (present.includes(l)) return true;
    errors.push(`${l}: нет каталога`);
    return false;
  });
  if (!locales.includes(SOURCE)) return errors;

  for (const l of locales) {
    const extra = readdirSync(join(dir, l)).filter(
      (f) => f.endsWith('.json') && !(NAMESPACES as readonly string[]).includes(f.slice(0, -5)),
    );
    for (const f of extra)
      errors.push(`${l}: лишний файл ${f} (пространства имён нет в NAMESPACES)`);
  }
  for (const ns of NAMESPACES) {
    const source = loadNamespace(dir, SOURCE, ns, errors);
    if (!source) continue;
    for (const l of locales) {
      const entries = l === SOURCE ? source : loadNamespace(dir, l, ns, errors);
      if (entries) checkNamespace(l, ns, entries, source, errors);
    }
  }
  return errors;
}

// ---- кириллица в коде ----

function sourceFiles(dir: string, skip: (rel: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const rel = relative(dir, p);
      if (statSync(p).isDirectory()) {
        if (!skip(rel + '/')) walk(p);
      } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) && !skip(rel)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

function parse(file: string) {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, kind);
}

/** Строковые литералы, части шаблонных строк и текст JSX (комментарии в дерево не входят). */
function isTextNode(n: ts.Node): n is ts.LiteralLikeNode {
  return (
    ts.isStringLiteral(n) ||
    ts.isNoSubstitutionTemplateLiteral(n) ||
    ts.isTemplateHead(n) ||
    ts.isTemplateMiddle(n) ||
    ts.isTemplateTail(n) ||
    ts.isJsxText(n)
  );
}

function cyrillicIn(sf: ts.SourceFile, root: ts.Node, found: string[]) {
  const visit = (n: ts.Node) => {
    if (isTextNode(n) && CYRILLIC.test(n.text)) {
      const { line } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
      found.push(`${relative(ROOT, sf.fileName)}:${line + 1}: ${n.text.trim().slice(0, 60)}`);
    }
    n.forEachChild(visit);
  };
  visit(root);
}

/**
 * Пути apps/web/src (префиксы), где кириллица в строках допустима (§44.6). Файлы *.test.* исключены всегда.
 */
const WEB_CYRILLIC_EXCEPTIONS = [
  // Справка по шаблонам — по-русски до этапа 3 локализации.
  'pages/admin/help/',
  // Помощники и фикстуры тестов: данные на русском, как в самих тестах.
  'test/',
];

/** Непереведённые строки веба: всё в apps/web/src, кроме тестов и исключений выше. */
function findCyrillicInWeb(dir = join(ROOT, 'apps/web/src')): string[] {
  const found: string[] = [];
  const skip = (rel: string) => WEB_CYRILLIC_EXCEPTIONS.some((p) => rel.startsWith(p));
  for (const f of sourceFiles(dir, skip)) {
    const sf = parse(f);
    cyrillicIn(sf, sf, found);
  }
  return found;
}

const ERROR_CALLEES = new Set(['AppError', 'badRequest', 'notFound', 'conflict', 'forbidden']);

/** Русский текст вместо ключа каталога errors в AppError и помощниках ошибок API. */
function findCyrillicInAppErrors(dir = join(ROOT, 'apps/api/src')): string[] {
  const found: string[] = [];
  for (const f of sourceFiles(dir, () => false)) {
    const sf = parse(f);
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
        const callee = n.expression;
        const name = ts.isIdentifier(callee)
          ? callee.text
          : ts.isPropertyAccessExpression(callee)
            ? callee.name.text
            : '';
        if (ERROR_CALLEES.has(name)) for (const a of n.arguments ?? []) cyrillicIn(sf, a, found);
      }
      n.forEachChild(visit);
    };
    visit(sf);
  }
  return found;
}

function main() {
  const arg = process.argv.slice(2).find((a) => a !== '--');
  const dir = resolve(arg ?? join(ROOT, 'packages/shared/src/i18n'));
  const errors = checkCatalogs(dir);
  if (CHECK_WEB_CYRILLIC)
    errors.push(...findCyrillicInWeb().map((s) => `кириллица в коде веба: ${s}`));
  if (CHECK_API_ERRORS)
    errors.push(...findCyrillicInAppErrors().map((s) => `кириллица в ошибке API: ${s}`));
  if (errors.length) {
    console.error(`Ошибки каталогов переводов (${errors.length}):`);
    for (const e of errors) console.error(`- ${e}`);
    process.exit(1);
  }
  console.log(
    `Каталоги переводов в порядке (языков: ${LOCALES.length}, пространств имён: ${NAMESPACES.length}).`,
  );
}

main();
