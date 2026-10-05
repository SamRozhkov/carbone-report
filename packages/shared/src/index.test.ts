import { describe, expect, it } from 'vitest';
import { DatasourceBody, TemplateParam, TemplateQuery, outputFormatsFor } from './index';

describe('TemplateQuery', () => {
  it('принимает корректный ключ', () => {
    expect(TemplateQuery.parse({ key: 'orders', sql: 'select 1', mode: 'list' }).key).toBe(
      'orders',
    );
  });
  it('отклоняет зарезервированный ключ params', () => {
    expect(TemplateQuery.safeParse({ key: 'params', sql: 'select 1', mode: 'list' }).success).toBe(
      false,
    );
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
      name: 'status',
      label: 'Статус',
      type: 'select',
      required: true,
      defaultValue: null,
      options: null,
    });
    expect(r.success).toBe(false);
  });
  it('отклоняет имя параметра constructor', () => {
    const r = TemplateParam.safeParse({
      name: 'constructor',
      label: 'X',
      type: 'string',
      required: false,
      defaultValue: null,
      options: null,
    });
    expect(r.success).toBe(false);
  });
  it('принимает date-параметр без options', () => {
    const r = TemplateParam.safeParse({
      name: 'dateFrom',
      label: 'С',
      type: 'date',
      required: true,
      defaultValue: null,
      options: null,
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

describe('DatasourceBody: SSL', () => {
  const base = { name: 'n', host: 'h', port: 5432, database: 'd', username: 'u' };
  it('sslMode обязателен; sslCa по умолчанию null', () => {
    const missing = DatasourceBody.safeParse(base);
    expect(missing.success).toBe(false);
    expect(missing.error!.issues[0]!.path).toEqual(['sslMode']);
    expect(DatasourceBody.parse({ ...base, sslMode: 'disable' }).sslCa).toBeNull();
  });
  it('CA без режима verify — ошибка у поля sslCa', () => {
    const r = DatasourceBody.safeParse({
      ...base,
      sslMode: 'require',
      sslCa: '-----BEGIN CERTIFICATE-----x',
    });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0]!.path).toEqual(['sslCa']);
  });
  it('verify с не-PEM — ошибка', () => {
    expect(DatasourceBody.safeParse({ ...base, sslMode: 'verify', sslCa: 'abc' }).success).toBe(
      false,
    );
  });
  it('verify с PEM и verify без CA — ок; пустая строка CA = null', () => {
    expect(
      DatasourceBody.parse({
        ...base,
        sslMode: 'verify',
        sslCa: '-----BEGIN CERTIFICATE-----\nAA\n-----END CERTIFICATE-----',
      }).sslCa,
    ).toContain('BEGIN');
    expect(DatasourceBody.parse({ ...base, sslMode: 'verify', sslCa: '  ' }).sslCa).toBeNull();
  });
});
