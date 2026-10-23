import { describe, expect, it } from 'vitest';
import { scanSql, type SqlSegment } from './sql-scan';

const parts = (sql: string) =>
  scanSql(sql).map((s: SqlSegment) => [s.kind, sql.slice(s.start, s.end)]);

describe('scanSql', () => {
  it('пустая строка — нет участков', () => {
    expect(scanSql('')).toEqual([]);
  });

  it('только код — один участок', () => {
    expect(parts('select 1')).toEqual([['code', 'select 1']]);
  });

  it('комментарии, строки, идентификаторы в кавычках, долларовые строки', () => {
    expect(
      parts(`select 'a''b', "x""y" -- c\nfrom /* a /* b */ c */ t where s = $q$ ; $q$`),
    ).toEqual([
      ['code', 'select '],
      ['string', "'a''b'"],
      ['code', ', '],
      ['quotedIdent', '"x""y"'],
      ['code', ' '],
      ['lineComment', '-- c\n'],
      ['code', 'from '],
      ['blockComment', '/* a /* b */ c */'],
      ['code', ' t where s = '],
      ['dollarString', '$q$ ; $q$'],
    ]);
  });

  it("E'…' с обратной косой: \\' не закрывает строку; префикс E — в коде", () => {
    expect(parts("select E'a\\'b', 1")).toEqual([
      ['code', 'select E'],
      ['string', "'a\\'b'"],
      ['code', ', 1'],
    ]);
  });

  it('$$…$$ и $1: позиционный параметр — код, не долларовая строка', () => {
    expect(parts('select $$x$$, $1')).toEqual([
      ['code', 'select '],
      ['dollarString', '$$x$$'],
      ['code', ', $1'],
    ]);
  });

  it('a$b$c — идентификатор с $, не долларовая строка', () => {
    expect(parts('select a$b$c')).toEqual([['code', 'select a$b$c']]);
  });

  it('$ внутри идентификатора (в т. ч. после не-ASCII буквы) — не начало долларовой строки', () => {
    expect(parts('select 1 as a$$x$, pg_sleep(0) as y, $x$abc$x$ as z')).toEqual([
      ['code', 'select 1 as a$$x$, pg_sleep(0) as y, '],
      ['dollarString', '$x$abc$x$'],
      ['code', ' as z'],
    ]);
    expect(parts('select 1 as ä$x$, pg_sleep(1) as y, $x$abc$x$')).toEqual([
      ['code', 'select 1 as ä$x$, pg_sleep(1) as y, '],
      ['dollarString', '$x$abc$x$'],
    ]);
    // Закрывающий $a$ — конец участка, а не идентификатор: следующий $b$ — новая строка.
    expect(parts('select $a$x$a$$b$y$b$')).toEqual([
      ['code', 'select '],
      ['dollarString', '$a$x$a$'],
      ['dollarString', '$b$y$b$'],
    ]);
    expect(parts('select a$b$c, $x$y$x$')).toEqual([
      ['code', 'select a$b$c, '],
      ['dollarString', '$x$y$x$'],
    ]);
  });

  it('тег долларовой строки с не-ASCII буквами', () => {
    expect(parts("select $ä$'$ä$ as a, pg_sleep(0) as b, 'x' as c")).toEqual([
      ['code', 'select '],
      ['dollarString', "$ä$'$ä$"],
      ['code', ' as a, pg_sleep(0) as b, '],
      ['string', "'x'"],
      ['code', ' as c'],
    ]);
  });

  it('префикс E\'…\' — только отдельным словом; после "x" — да, после äe — нет', () => {
    expect(parts(`select "x"e'\\'' as v`)).toEqual([
      ['code', 'select '],
      ['quotedIdent', '"x"'],
      ['code', 'e'],
      ['string', "'\\''"],
      ['code', ' as v'],
    ]);
    expect(parts("select äe'\\', pg_sleep(0) as s, 'x'")).toEqual([
      ['code', 'select äe'],
      ['string', "'\\'"],
      ['code', ', pg_sleep(0) as s, '],
      ['string', "'x'"],
    ]);
  });

  it('-- и /* сразу после строки — комментарии; внутри строки — нет', () => {
    expect(parts("select 'a'--c\n, '--', '/*', 'b'/*c*/")).toEqual([
      ['code', 'select '],
      ['string', "'a'"],
      ['lineComment', '--c\n'],
      ['code', ', '],
      ['string', "'--'"],
      ['code', ', '],
      ['string', "'/*'"],
      ['code', ', '],
      ['string', "'b'"],
      ['blockComment', '/*c*/'],
    ]);
  });

  it('-- заканчивается и на \\r (как в PostgreSQL)', () => {
    expect(parts('select 1 -- c\r, pg_sleep(0)')).toEqual([
      ['code', 'select 1 '],
      ['lineComment', '-- c\r'],
      ['code', ', pg_sleep(0)'],
    ]);
  });

  it('незакрытые строка, комментарий, кавычки, $$ — до конца текста', () => {
    expect(parts("select 'abc")).toEqual([
      ['code', 'select '],
      ['string', "'abc"],
    ]);
    expect(parts('select /* /* */ x')).toEqual([
      ['code', 'select '],
      ['blockComment', '/* /* */ x'],
    ]);
    expect(parts('select "abc')).toEqual([
      ['code', 'select '],
      ['quotedIdent', '"abc'],
    ]);
    expect(parts('select $$abc')).toEqual([
      ['code', 'select '],
      ['dollarString', '$$abc'],
    ]);
    expect(parts('select 1 -- x')).toEqual([
      ['code', 'select 1 '],
      ['lineComment', '-- x'],
    ]);
  });

  it('участки покрывают строку подряд', () => {
    const sql = `a 'b' "c" -- d\n/* e */ $f$g$f$ h`;
    const segs = scanSql(sql);
    expect(segs[0]!.start).toBe(0);
    for (let k = 1; k < segs.length; k++) expect(segs[k]!.start).toBe(segs[k - 1]!.end);
    expect(segs.at(-1)!.end).toBe(sql.length);
  });
});
