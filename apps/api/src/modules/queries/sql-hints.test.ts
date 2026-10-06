import { describe, expect, it } from 'vitest';
import { sqlParamHint } from './sql-hints';

const pgErr = (code: string, message = 'ошибка') => Object.assign(new Error(message), { code });

describe('sqlParamHint', () => {
  it('массив сравнивается через = — подсказывает = any(:имя)', () => {
    const sql = 'select id from invoices where company_id = :companyId';
    expect(sqlParamHint(sql, ['companyId'], { companyId: ['1', '2'] }, pgErr('22P02'))).toBe(
      'параметр :companyId — множественный выбор: сравнивайте через = any(:companyId)',
    );
  });

  it('несколько массивов перечисляются', () => {
    const sql = 'where a = :a and b = :b';
    expect(sqlParamHint(sql, ['a', 'b'], { a: [1], b: [2] }, pgErr('42883'))).toBe(
      'параметры :a, :b — множественный выбор: сравнивайте через = any(:имя)',
    );
  });

  it('одиночное значение в any(...) — подсказывает = :имя', () => {
    const sql = 'where company_id = any(:companyId)';
    expect(
      sqlParamHint(
        sql,
        ['companyId'],
        { companyId: '1' },
        pgErr('22P02', 'malformed array literal: "1"'),
      ),
    ).toBe('параметр :companyId — одно значение: сравнивайте через = :companyId');
  });

  it('any без оператора — синтаксическая ошибка, подсказывает = any(...)', () => {
    const sql = 'where company_id any(:companyId)';
    expect(
      sqlParamHint(
        sql,
        ['companyId'],
        { companyId: ['1'] },
        pgErr('42601', 'syntax error at or near "any"'),
      ),
    ).toBe('перед any нужен оператор сравнения: = any(:имя)');
  });

  it('массив уже в any(...), all(...), unnest или с приведением ::int[] — подсказки нет', () => {
    const cases = [
      'where c = any(:x::int[])',
      'where c <> all(:x)',
      'where c in (select unnest(:x))',
      'where c = any((:x))',
      'where :x && arr',
    ];
    for (const sql of cases) {
      expect(sqlParamHint(sql, ['x'], { x: ['a'] }, pgErr('22P02')), sql).toBeUndefined();
    }
  });

  it('42804 для массива через = тоже даёт подсказку', () => {
    expect(sqlParamHint('where c = :x', ['x'], { x: [1] }, pgErr('42804'))).toContain('= any(:x)');
  });

  it('ссылка в комментарии не считается', () => {
    const sql = 'where c = any(:a) -- раньше было = :a';
    expect(sqlParamHint(sql, ['a'], { a: ['1'] }, pgErr('22P02'))).toBeUndefined();
  });

  it('строка в any(:имя): подсказка только при malformed array literal', () => {
    const sql = 'where c = any(:s::text[])';
    expect(sqlParamHint(sql, ['s'], { s: '{a,b}' }, pgErr('42883'))).toBeUndefined();
    expect(
      sqlParamHint(
        'where c = any(:s)',
        ['s'],
        { s: 'x' },
        pgErr('22P02', 'malformed array literal: "x"'),
      ),
    ).toBe('параметр :s — одно значение: сравнивайте через = :s');
  });

  it('пустой необязательный параметр (null) — подсказки нет', () => {
    expect(sqlParamHint('where c = any(:x)', ['x'], { x: null }, pgErr('22P02'))).toBeUndefined();
    expect(sqlParamHint('where c = :x', ['x'], { x: null }, pgErr('22P02'))).toBeUndefined();
  });

  it('near "any" без признаков пропущенного оператора — подсказки нет', () => {
    const e = pgErr('42601', 'syntax error at or near "any"');
    expect(sqlParamHint('select any from t', [], {}, e)).toBeUndefined();
  });

  it('не Error и null не роняют разбор', () => {
    expect(sqlParamHint('where c = :x', ['x'], { x: [1] }, null)).toBeUndefined();
    expect(sqlParamHint('where c = :x', ['x'], { x: [1] }, undefined)).toBeUndefined();
    expect(sqlParamHint('where c = :x', ['x'], { x: [1] }, 'строка')).toBeUndefined();
  });

  it('другие ошибки и запросы без массивов — подсказки нет', () => {
    expect(sqlParamHint('where a = :a', ['a'], { a: ['1'] }, pgErr('42P01'))).toBeUndefined();
    expect(sqlParamHint('where a = :a', ['a'], { a: 'x' }, pgErr('22P02'))).toBeUndefined();
    expect(sqlParamHint('select 1', [], {}, new Error('x'))).toBeUndefined();
  });
});
