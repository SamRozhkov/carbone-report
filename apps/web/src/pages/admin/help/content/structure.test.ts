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
/**
 * Имена форматтеров в порядке появления, с аргументами и без (`:aggSum`, `:html`): в теле каждого тега
 * строковые аргументы (их можно переводить, §46.3) заменены на '', затем — каждое `:имя`.
 */
const formatters = (template: string) =>
  [...template.matchAll(/\{([^{}]*)\}/g)].flatMap((m) =>
    [...m[1]!.replace(/'[^']*'/g, "''").matchAll(/:([A-Za-z]+)/g)].map((x) => x[1]),
  );

/** id примеров, где форматтеры модуля не совпадают с ru. */
const formatterMismatches = (mod: HelpContent) => {
  const map = new Map(examplesOf(mod).map((e) => [e.id, e]));
  return examplesOf(HELP_RU)
    .filter((e) => {
      const o = map.get(e.id);
      return !o || formatters(o.template).join() !== formatters(e.template).join();
    })
    .map((e) => e.id);
};

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

  it('самопроверка: форматтеры без аргументов сравниваются (aggSum → aggAvg ловится)', () => {
    const withAggSum = examplesOf(HELP_RU).filter((e) => /:aggSum\b/.test(e.template));
    expect(withAggSum.length).toBeGreaterThan(0);
    const target = withAggSum[0]!.id;
    expect(formatters(withAggSum[0]!.template)).toContain('aggSum');
    const swap = (c: HelpContent, from: string, to: string): HelpContent => ({
      HELP_INTRO: c.HELP_INTRO,
      HELP_SECTIONS: c.HELP_SECTIONS.map((s) => ({
        ...s,
        examples: s.examples.map((e) =>
          e.id === target ? { ...e, template: e.template.replace(from, to) } : e,
        ),
      })),
    });
    expect(formatterMismatches(swap(HELP_RU, ':aggSum', ':aggAvg'))).toEqual([target]);
    // Переведённый строковый аргумент не считается расхождением.
    expect(formatterMismatches({ ...HELP_RU })).toEqual([]);
    expect(formatters("{d.x:ifEmpty('—'):formatD('DD.MM.YYYY')}")).toEqual(
      formatters("{d.x:ifEmpty('n/a: x'):formatD('MM/DD/YYYY')}"),
    );
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

  it('форматтеры (с аргументами и без) — те же и в том же порядке', () => {
    expect(formatterMismatches(mod)).toEqual([]);
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
