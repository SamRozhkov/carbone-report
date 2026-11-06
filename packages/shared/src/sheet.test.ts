import { describe, expect, it } from 'vitest';
import type { QueryProbe } from './assistant';
import { parseRef, toRef, parseRange, SheetSnapshot } from './sheet';

const ok = {
  name: 'Лист1',
  cells: [{ ref: 'C3', text: 'x' }],
  usedRange: 'C3:AB40',
  active: 'C3',
  truncated: false,
};

describe('parseRef/toRef/parseRange', () => {
  it('разбирает ссылки', () => {
    expect(parseRef('A1')).toEqual({ row: 0, col: 0 });
    expect(parseRef('Z9')).toEqual({ row: 8, col: 25 });
    expect(parseRef('AA10')).toEqual({ row: 9, col: 26 });
    expect(parseRef('AX500')).toEqual({ row: 499, col: 49 });
    expect(parseRef('AB40')).toEqual({ row: 39, col: 27 });
    for (const bad of ['a1', 'A0', '1A', '$A$1']) expect(parseRef(bad)).toBeNull();
  });
  it('toRef обратен parseRef', () => {
    for (const r of ['A1', 'Z9', 'AA10', 'AX500']) {
      const p = parseRef(r)!;
      expect(toRef(p.row, p.col)).toBe(r);
    }
  });
  it('parseRange', () => {
    expect(parseRange('C3:AB40')).toEqual({ top: 2, left: 2, bottom: 39, right: 27 });
    expect(parseRange('A1')).toEqual({ top: 0, left: 0, bottom: 0, right: 0 });
    expect(parseRange('B2:A1')).toBeNull();
  });
});

describe('SheetSnapshot', () => {
  const bad = (o: object) => SheetSnapshot.safeParse({ ...ok, ...o }).success;
  it('принимает пример', () => expect(SheetSnapshot.safeParse(ok).success).toBe(true));
  it('лимиты', () => {
    const many = Array.from({ length: 5001 }, (_, i) => ({
      ref: toRef(i % 500, Math.floor(i / 500)),
      text: '',
    }));
    expect(bad({ cells: many })).toBe(false);
    expect(bad({ cells: [{ ref: 'A1', text: 'x'.repeat(501) }] })).toBe(false);
    const big = Array.from({ length: 61 }, (_, i) => ({ ref: toRef(i, 0), text: 'x'.repeat(500) }));
    expect(bad({ cells: big })).toBe(false);
    expect(bad({ usedRange: 'A1:A501' })).toBe(false);
    expect(bad({ usedRange: 'A1:AY1' })).toBe(false);
    expect(
      bad({
        cells: [
          { ref: 'A1', text: '' },
          { ref: 'A1', text: '' },
        ],
      }),
    ).toBe(false);
    expect(bad({ cells: [{ ref: 'a1', text: '' }] })).toBe(false);
  });
});

describe('QueryProbe', () => {
  it('типы вложенных колонок ограничены', () => {
    const p: QueryProbe = {
      ok: true,
      sampled: true,
      nested: [{ column: 'items', columns: [{ name: 'n', type: 'number' }] }],
    };
    expect(p.ok).toBe(true);
    const col = { name: 'n', type: 'int4' };
    // @ts-expect-error неизвестный тип колонки
    const bad: QueryProbe = { ok: true, sampled: true, nested: [{ column: 'a', columns: [col] }] };
    expect(bad.ok).toBe(true);
  });
});
