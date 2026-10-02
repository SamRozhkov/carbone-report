import { describe, expect, it } from 'vitest';
import { TemplateParam, TemplateQuery, outputFormatsFor } from './index';

describe('TemplateQuery', () => {
  it('принимает корректный ключ', () => {
    expect(TemplateQuery.parse({ key: 'orders', sql: 'select 1', mode: 'list' }).key).toBe('orders');
  });
  it('отклоняет зарезервированный ключ params', () => {
    expect(TemplateQuery.safeParse({ key: 'params', sql: 'select 1', mode: 'list' }).success).toBe(false);
  });
  it('отклоняет ключ __proto__', () => {
    const r = TemplateQuery.safeParse({ key: '__proto__', sql: 'select 1', mode: 'list' });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toBe('зарезервированное имя');
  });
  it('отклоняет ключ с пробелом и ключ, начинающийся с цифры', () => {
    expect(TemplateQuery.safeParse({ key: 'my key', sql: 'x', mode: 'list' }).success).toBe(false);
    expect(TemplateQuery.safeParse({ key: '1abc', sql: 'x', mode: 'list' }).success).toBe(false);
  });
});

describe('TemplateParam', () => {
  it('требует options для select', () => {
    const r = TemplateParam.safeParse({
      name: 'status', label: 'Статус', type: 'select', required: true, defaultValue: null, options: null,
    });
    expect(r.success).toBe(false);
  });
  it('отклоняет имя параметра constructor', () => {
    const r = TemplateParam.safeParse({
      name: 'constructor', label: 'X', type: 'string', required: false, defaultValue: null, options: null,
    });
    expect(r.success).toBe(false);
  });
  it('принимает date-параметр без options', () => {
    const r = TemplateParam.safeParse({
      name: 'dateFrom', label: 'С', type: 'date', required: true, defaultValue: null, options: null,
    });
    expect(r.success).toBe(true);
  });
});

describe('outputFormatsFor', () => {
  it('для docx — pdf, docx, odt', () => {
    expect(outputFormatsFor('docx')).toEqual(['pdf', 'docx', 'odt']);
  });
  it('для xlsx — pdf, xlsx, ods', () => {
    expect(outputFormatsFor('xlsx')).toEqual(['pdf', 'xlsx', 'ods']);
  });
  it('для pptx — pdf, pptx', () => {
    expect(outputFormatsFor('pptx')).toEqual(['pdf', 'pptx']);
  });
});
