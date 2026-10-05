import { describe, expect, it } from 'vitest';
import { rowsToOptions } from './executor';

describe('rowsToOptions', () => {
  it('колонки value/label в любом порядке', () => {
    expect(rowsToOptions(['label', 'x', 'value'], [{ label: 'Один', x: 0, value: 1 }])).toEqual([
      { value: 1, label: 'Один' },
    ]);
  });
  it('иначе первая — значение, вторая — подпись', () => {
    expect(rowsToOptions(['id', 'name'], [{ id: 'a', name: 'А' }])).toEqual([
      { value: 'a', label: 'А' },
    ]);
  });
  it('одна колонка — и значение, и подпись; не строка/число → String', () => {
    expect(rowsToOptions(['g'], [{ g: 7 }, { g: true }])).toEqual([
      { value: 7, label: '7' },
      { value: 'true', label: 'true' },
    ]);
  });
  it('null в подписи → подпись из значения', () => {
    expect(rowsToOptions(['value', 'label'], [{ value: 3, label: null }])).toEqual([
      { value: 3, label: '3' },
    ]);
  });
});
