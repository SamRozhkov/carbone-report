import { LOCALES } from '@carbone-reports/shared/i18n';
import { describe, expect, it } from 'vitest';
import { HELP_MODULES, HELP_RU, type HelpContent, type HelpExample } from '.';

// Модули языков повторяют ru по всему, что не переводится (§46.4); добавленный в HELP_MODULES
// язык попадает в тест сам.
const OTHERS: [string, HelpContent][] = await Promise.all(
  Object.entries(HELP_MODULES).map(async ([l, load]) => [l, await load()] as [string, HelpContent]),
);

const examplesOf = (c: HelpContent) => c.HELP_SECTIONS.flatMap((s) => s.examples);

/** Пути данных в тегах (`d.…`, `c.…` до первого `:`) — набор. */
const dataPaths = (template: string) =>
  [...new Set([...template.matchAll(/\{([dc]\.[^}:]*)/g)].map((m) => m[1]!.trim()))].sort();
/** Имена форматтеров с аргументами — в порядке появления. */
const formatters = (template: string) => [...template.matchAll(/:([A-Za-z]+)\(/g)].map((m) => m[1]);

/** Ключи JSON `data` рекурсивно: «a.b», элементы массива — «a[]». */
function jsonKeys(v: unknown, prefix = '', out = new Set<string>()): string[] {
  if (Array.isArray(v)) for (const x of v) jsonKeys(x, `${prefix}[]`, out);
  else if (typeof v === 'object' && v !== null)
    for (const [k, x] of Object.entries(v)) {
      const path = prefix ? `${prefix}.${k}` : k;
      out.add(path);
      jsonKeys(x, path, out);
    }
  return [...out].sort();
}

const flags = (e: HelpExample) => ({
  unavailable: e.unavailable,
  antiPattern: e.antiPattern,
  picture: e.picture,
  rich: e.rich,
});

describe('структура модулей справки', () => {
  it('таблица модулей: только языки интерфейса, кроме ru; каждый модуль загружается', () => {
    const allowed = LOCALES.filter((l) => l !== 'ru') as string[];
    for (const l of Object.keys(HELP_MODULES)) expect(allowed).toContain(l);
    expect(OTHERS.map(([l]) => l)).toEqual(Object.keys(HELP_MODULES));
    for (const [l, c] of OTHERS) expect(examplesOf(c).length, l).toBeGreaterThan(0);
  });
});

describe.each(OTHERS)('структура справки %s совпадает с ru', (_locale, mod) => {
  const ru = examplesOf(HELP_RU);
  const other = examplesOf(mod);
  const byId = (list: HelpExample[]) => new Map(list.map((e) => [e.id, e]));

  it('разделы и примеры: те же id в том же порядке', () => {
    const ids = (c: HelpContent) => c.HELP_SECTIONS.map((s) => [s.id, s.examples.map((e) => e.id)]);
    expect(ids(mod)).toEqual(ids(HELP_RU));
  });

  it('ограничения: те же id', () => {
    const ids = (c: HelpContent) =>
      c.HELP_SECTIONS.map((s) => [s.id, (s.limits ?? []).map((l) => l.id)]);
    expect(ids(mod)).toEqual(ids(HELP_RU));
  });

  it('флаги и SQL-запросы те же', () => {
    const map = byId(other);
    for (const e of ru) {
      const o = map.get(e.id)!;
      expect(flags(o), e.id).toEqual(flags(e));
      expect(o.sql, e.id).toEqual(e.sql);
    }
  });

  it('пути данных в тегах — тот же набор, форматтеры — те же и в том же порядке', () => {
    const map = byId(other);
    for (const e of ru) {
      const o = map.get(e.id)!;
      expect(dataPaths(o.template), e.id).toEqual(dataPaths(e.template));
      expect(formatters(o.template), e.id).toEqual(formatters(e.template));
    }
  });

  it('data — корректный JSON с теми же ключами', () => {
    const map = byId(other);
    for (const e of ru) {
      const o = map.get(e.id)!;
      expect(jsonKeys(JSON.parse(o.data)), e.id).toEqual(jsonKeys(JSON.parse(e.data)));
    }
  });
});
