import type { TemplateParam } from '@carbone-reports/shared';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../lib/errors';
import { checkParamDefaults, resolveParams } from './params';

const def = (
  over: Partial<TemplateParam> & Pick<TemplateParam, 'name' | 'type'>,
): TemplateParam => ({
  label: over.name,
  required: false,
  defaultValue: null,
  options: null,
  sql: null,
  multiple: false,
  ...over,
});

function fieldsOf(fn: () => unknown): Record<string, string> {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    return ((e as AppError).details as { fields: Record<string, string> }).fields;
  }
  throw new Error('ожидалась ошибка');
}

describe('resolveParams', () => {
  it('принимает значения правильных типов', () => {
    const defs = [
      def({ name: 's', type: 'string' }),
      def({ name: 'n', type: 'number' }),
      def({ name: 'd', type: 'date' }),
      def({ name: 'b', type: 'boolean' }),
      def({ name: 'sel', type: 'select', options: [{ value: 'new', label: 'Новый' }] }),
    ];
    expect(resolveParams(defs, { s: 'x', n: 1.5, d: '2026-01-31', b: false, sel: 'new' })).toEqual({
      s: 'x',
      n: 1.5,
      d: '2026-01-31',
      b: false,
      sel: 'new',
    });
  });

  it('подставляет default, затем null для необязательных', () => {
    const defs = [
      def({ name: 'a', type: 'number', defaultValue: 10 }),
      def({ name: 'b', type: 'string' }),
    ];
    expect(resolveParams(defs, {})).toEqual({ a: 10, b: null });
  });

  it('пустая строка считается отсутствующим значением', () => {
    expect(
      resolveParams([def({ name: 'a', type: 'string', defaultValue: 'x' })], { a: '' }),
    ).toEqual({ a: 'x' });
  });

  it('обязательный без значения и без default → ошибка поля', () => {
    expect(
      fieldsOf(() => resolveParams([def({ name: 'a', type: 'date', required: true })], {})),
    ).toEqual({
      a: 'обязательный параметр',
    });
  });

  it('несуществующая дата и неверный формат даты → ошибка', () => {
    const defs = [def({ name: 'a', type: 'date' }), def({ name: 'b', type: 'date' })];
    expect(fieldsOf(() => resolveParams(defs, { a: '2026-02-30', b: '31.01.2026' }))).toEqual({
      a: 'ожидается дата ГГГГ-ММ-ДД',
      b: 'ожидается дата ГГГГ-ММ-ДД',
    });
  });

  it('строка вместо числа, NaN-подобное и значение вне select → ошибки', () => {
    const defs = [
      def({ name: 'n', type: 'number' }),
      def({ name: 's', type: 'select', options: [{ value: 'a', label: 'A' }] }),
      def({ name: 'b', type: 'boolean' }),
    ];
    expect(fieldsOf(() => resolveParams(defs, { n: '5', s: 'zzz', b: 'true' }))).toEqual({
      n: 'ожидается число',
      s: 'недопустимое значение',
      b: 'ожидается да/нет',
    });
  });

  it('унаследованные свойства не считаются значениями', () => {
    expect(resolveParams([def({ name: 'toString', type: 'string' })], {})).toEqual({
      toString: null,
    });
  });

  it('лишние ключи во входе игнорируются', () => {
    expect(resolveParams([], { hacker: "'; drop table x; --" })).toEqual({});
  });
});

describe('checkParamDefaults', () => {
  it('отклоняет default неверного типа', () => {
    expect(
      fieldsOf(() => checkParamDefaults([def({ name: 'n', type: 'number', defaultValue: 'abc' })])),
    ).toEqual({
      n: 'значение по умолчанию: ожидается число',
    });
  });
  it('принимает null default', () => {
    expect(() => checkParamDefaults([def({ name: 'n', type: 'number' })])).not.toThrow();
  });
});
