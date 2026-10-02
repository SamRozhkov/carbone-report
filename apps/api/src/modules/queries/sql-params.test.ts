import { describe, expect, it } from 'vitest';
import { parseSqlParams, SqlParamError } from './sql-params';

const p = parseSqlParams;

describe('parseSqlParams', () => {
  it('заменяет параметры на $n по порядку первого появления', () => {
    expect(p('select * from t where a = :a and b > :b')).toEqual({
      text: 'select * from t where a = $1 and b > $2',
      names: ['a', 'b'],
    });
  });
  it('одинаковые имена получают один номер', () => {
    expect(p('where a = :x or b = :x or c = :y')).toEqual({
      text: 'where a = $1 or b = $1 or c = $2',
      names: ['x', 'y'],
    });
  });
  it('не трогает приведения типов ::', () => {
    expect(p('select :d::date, x::text')).toEqual({ text: 'select $1::date, x::text', names: ['d'] });
  });
  it('не трогает строковые литералы, включая экранированные кавычки', () => {
    expect(p("select ':no', 'it''s :no', :yes")).toEqual({
      text: "select ':no', 'it''s :no', $1",
      names: ['yes'],
    });
  });
  it("не трогает E'...' со слешами", () => {
    expect(p("select E'a\\' :no', :yes")).toEqual({ text: "select E'a\\' :no', $1", names: ['yes'] });
  });
  it('не трогает dollar-quoted строки', () => {
    expect(p('select $$ :no $$, $tag$ :no $tag$, :yes')).toEqual({
      text: 'select $$ :no $$, $tag$ :no $tag$, $1',
      names: ['yes'],
    });
  });
  it('не трогает идентификаторы в кавычках', () => {
    expect(p('select "col:no" from t where x = :yes')).toEqual({
      text: 'select "col:no" from t where x = $1',
      names: ['yes'],
    });
  });
  it('не трогает комментарии обоих видов, включая вложенные', () => {
    expect(p('select 1 -- :no\n, :yes /* :no /* :no */ :no */')).toEqual({
      text: 'select 1 -- :no\n, $1 /* :no /* :no */ :no */',
      names: ['yes'],
    });
  });
  it('не трогает срезы массивов с числами', () => {
    expect(p('select arr[1:2] from t')).toEqual({ text: 'select arr[1:2] from t', names: [] });
  });
  it('не трогает срезы массивов с идентификаторами', () => {
    expect(p('select a[1:n], b[lo:hi] from t where x = :p')).toEqual({
      text: 'select a[1:n], b[lo:hi] from t where x = $1',
      names: ['p'],
    });
  });
  it('параметр в конце строки и рядом со скобками', () => {
    expect(p('where id in (:a,:b)')).toEqual({ text: 'where id in ($1,$2)', names: ['a', 'b'] });
  });
  it('запрещает позиционные $1', () => {
    expect(() => p('select $1')).toThrow(SqlParamError);
  });
  it('незакрытая строка не зацикливается', () => {
    expect(p("select ':x")).toEqual({ text: "select ':x", names: [] });
  });
  it('SQL без параметров возвращается как есть', () => {
    expect(p('select now()')).toEqual({ text: 'select now()', names: [] });
  });
});
