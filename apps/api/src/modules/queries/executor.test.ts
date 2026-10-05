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

  describe('выбор колонок', () => {
    it('есть value и label', () => {
      expect(
        rowsToOptions(['name', 'label', 'value'], [{ name: 'n', label: 'L', value: 1 }]),
      ).toEqual([{ value: 1, label: 'L' }]);
    });
    it('только value: подпись — первая другая колонка', () => {
      expect(rowsToOptions(['name', 'value'], [{ name: 'Один', value: 1 }])).toEqual([
        { value: 1, label: 'Один' },
      ]);
    });
    it('только value без других колонок: подпись — значение', () => {
      expect(rowsToOptions(['value'], [{ value: 5 }])).toEqual([{ value: 5, label: '5' }]);
    });
    it('только label: значение — первая другая колонка', () => {
      expect(rowsToOptions(['label', 'id'], [{ label: 'Один', id: 1 }])).toEqual([
        { value: 1, label: 'Один' },
      ]);
    });
    it('нет ни value, ни label: первая — значение, вторая — подпись', () => {
      expect(rowsToOptions(['id', 'name', 'x'], [{ id: 1, name: 'Один', x: 0 }])).toEqual([
        { value: 1, label: 'Один' },
      ]);
    });
  });

  it('Date → ISO-строка в значении и подписи', () => {
    const d = new Date('2026-10-01T12:30:00.000Z');
    expect(rowsToOptions(['value', 'label'], [{ value: d, label: d }])).toEqual([
      { value: '2026-10-01T12:30:00.000Z', label: '2026-10-01T12:30:00.000Z' },
    ]);
  });

  it('повторы значений убираются, остаётся первое (по String(value))', () => {
    expect(
      rowsToOptions(
        ['value', 'label'],
        [
          { value: 1, label: 'Первый' },
          { value: '1', label: 'Строка' },
          { value: 2, label: 'Второй' },
          { value: 1, label: 'Снова' },
        ],
      ),
    ).toEqual([
      { value: 1, label: 'Первый' },
      { value: 2, label: 'Второй' },
    ]);
  });
});
