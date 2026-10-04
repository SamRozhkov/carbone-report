import type { TemplateParam } from '@carbone-reports/shared';
import { describe, expect, it } from 'vitest';
import { formatOptions, initialValues, parseOptions, pickParams } from './params';

const p = (over: Partial<TemplateParam> & Pick<TemplateParam, 'name' | 'type'>): TemplateParam => ({
  label: over.name,
  required: false,
  defaultValue: null,
  options: null,
  ...over,
});

describe('initialValues', () => {
  it('берёт default, для boolean без default — false, иначе null', () => {
    expect(
      initialValues([
        p({ name: 'a', type: 'string', defaultValue: 'x' }),
        p({ name: 'b', type: 'boolean' }),
        p({ name: 'c', type: 'date' }),
      ]),
    ).toEqual({ a: 'x', b: false, c: null });
  });
});

describe('pickParams', () => {
  it('оставляет только объявленные параметры, недостающие — null', () => {
    expect(
      pickParams([p({ name: 'a', type: 'string' }), p({ name: 'b', type: 'number' })], {
        a: 'x',
        old: 1,
      }),
    ).toEqual({
      a: 'x',
      b: null,
    });
  });
});

describe('parseOptions / formatOptions', () => {
  it('строки «value=label», «value», пустые и пробелы', () => {
    expect(parseOptions('new=Новый\n  done = Готов \n\narchived')).toEqual([
      { value: 'new', label: 'Новый' },
      { value: 'done', label: 'Готов' },
      { value: 'archived', label: 'archived' },
    ]);
  });
  it('знак = в подписи сохраняется', () => {
    expect(parseOptions('ge=Больше или = 10')).toEqual([{ value: 'ge', label: 'Больше или = 10' }]);
  });
  it('обратимость', () => {
    const opts = [
      { value: 'a', label: 'А' },
      { value: 'b', label: 'b' },
    ];
    expect(parseOptions(formatOptions(opts))).toEqual(opts);
    expect(formatOptions(opts)).toBe('a=А\nb');
  });
});
