import { describe, expect, it } from 'vitest';
import type { TemplateParam } from '@carbone-reports/shared';
import { orderParams, paramRefs } from './param-deps';

const p = (name: string, sql: string | null = null): TemplateParam => ({
  name,
  label: name,
  type: sql === null ? 'string' : 'query',
  required: false,
  defaultValue: null,
  options: null,
  sql,
  multiple: false,
});

describe('paramRefs', () => {
  it('берёт уникальные :имена, игнорирует ::cast и строки', () => {
    expect(
      paramRefs(
        p(
          'c',
          "select id from t where r = :region and d > :from::date and x = ':nope' and r2 = :region",
        ),
      ),
    ).toEqual(['region', 'from']);
  });
  it('не-query → []', () => expect(paramRefs(p('s'))).toEqual([]));
});

describe('orderParams', () => {
  it('родители раньше детей, остальное в исходном порядке', () => {
    const out = orderParams([
      p('city', 'select 1 where :region = 1'),
      p('x'),
      p('region', 'select 1'),
    ]);
    expect(out.map((d) => d.name)).toEqual(['x', 'region', 'city']);
  });
  it('неизвестная ссылка — ошибка у строки', () => {
    expect(() => orderParams([p('a'), p('c', 'select :zzz')])).toThrow(
      expect.objectContaining({
        code: 'VALIDATION',
        details: [{ path: '/1/sql', message: 'неизвестный параметр :zzz' }],
      }),
    );
  });
  it('ссылка на себя', () => {
    expect(() => orderParams([p('a', 'select :a')])).toThrow(
      expect.objectContaining({
        details: [{ path: '/0/sql', message: 'параметр не может ссылаться на себя' }],
      }),
    );
  });
  it('цикл', () => {
    expect(() => orderParams([p('a', 'select :b'), p('b', 'select :a')])).toThrow(
      expect.objectContaining({
        details: [expect.objectContaining({ message: 'циклическая зависимость: a → b → a' })],
      }),
    );
  });
  it('цикл из трёх', () => {
    expect(() =>
      orderParams([p('a', 'select :b'), p('b', 'select :c'), p('c', 'select :a')]),
    ).toThrow(
      expect.objectContaining({
        details: [expect.objectContaining({ message: 'циклическая зависимость: a → b → c → a' })],
      }),
    );
  });
  it('хвост, ведущий в цикл, в сообщение не попадает', () => {
    expect(() =>
      orderParams([p('d', 'select :b'), p('b', 'select :c'), p('c', 'select :b')]),
    ).toThrow(
      expect.objectContaining({
        details: [expect.objectContaining({ message: 'циклическая зависимость: b → c → b' })],
      }),
    );
  });
  it('query ссылается на string — допустимо', () => {
    expect(orderParams([p('c', 'select :s'), p('s')]).map((d) => d.name)).toEqual(['s', 'c']);
  });
  it('ошибка парсера ($1) → VALIDATION у строки', () => {
    expect(() => orderParams([p('a', 'select $1')])).toThrow(
      expect.objectContaining({
        code: 'VALIDATION',
        details: [expect.objectContaining({ path: '/0/sql' })],
      }),
    );
  });
});
