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

  it('массив уже в any(...) — подсказки нет', () => {
    const sql = 'where company_id = any(:companyId::int[])';
    expect(sqlParamHint(sql, ['companyId'], { companyId: ['x'] }, pgErr('22P02'))).toBeUndefined();
  });

  it('ссылка только в комментарии не считается', () => {
    expect(sqlParamHint('where a = 1 -- :a', [], { a: ['1'] }, pgErr('22P02'))).toBeUndefined();
  });

  it('другие ошибки и запросы без массивов — подсказки нет', () => {
    expect(sqlParamHint('where a = :a', ['a'], { a: ['1'] }, pgErr('42P01'))).toBeUndefined();
    expect(sqlParamHint('where a = :a', ['a'], { a: 'x' }, pgErr('22P02'))).toBeUndefined();
    expect(sqlParamHint('select 1', [], {}, new Error('x'))).toBeUndefined();
  });
});
