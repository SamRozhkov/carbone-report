import { describe, expect, it } from 'vitest';
import {
  ExportTemplatesBody,
  ImportDecisions,
  TransferManifest,
  transferFilePath,
  type TransferTemplate,
} from './template-transfer';

const SHA = 'a'.repeat(64);

function tpl(over: Partial<TransferTemplate> = {}): TransferTemplate {
  return {
    name: 'Счёт',
    description: '',
    fileExt: 'docx',
    defaultOutput: 'pdf',
    public: false,
    category: null,
    groups: [],
    datasource: {
      name: 'src',
      host: 'db',
      port: 5432,
      database: 'app',
      username: 'ro',
      sslMode: 'disable',
    },
    queries: [{ key: 'rows', sql: 'select 1', mode: 'list', sortOrder: 0 }],
    params: [
      {
        name: 'from',
        label: 'С',
        type: 'date',
        required: true,
        defaultValue: null,
        options: null,
        sql: null,
        multiple: false,
        sortOrder: 0,
      },
    ],
    file: transferFilePath(0, 'docx'),
    sha256: SHA,
    ...over,
  };
}

const manifest = (templates: TransferTemplate[] = [tpl()]) => ({
  format: 'carbone-reports/templates',
  formatVersion: 1,
  appVersion: '2.3.0',
  exportedAt: '2026-10-10T09:00:00.000Z',
  templates,
});

describe('TransferManifest', () => {
  it('принимает корректный манифест', () => {
    expect(TransferManifest.safeParse(manifest()).success).toBe(true);
  });

  it('не принимает чужой формат и версию', () => {
    expect(TransferManifest.safeParse({ ...manifest(), format: 'x' }).success).toBe(false);
    expect(TransferManifest.safeParse({ ...manifest(), formatVersion: 2 }).success).toBe(false);
  });

  it('лишние поля отвергаются (в манифесте, шаблоне, источнике)', () => {
    expect(TransferManifest.safeParse({ ...manifest(), extra: 1 }).success).toBe(false);
    expect(TransferManifest.safeParse(manifest([{ ...tpl(), id: 'x' } as never])).success).toBe(
      false,
    );
    const ds = { ...tpl().datasource, password: 'p' };
    expect(TransferManifest.safeParse(manifest([tpl({ datasource: ds } as never)])).success).toBe(
      false,
    );
  });

  it('пустой список шаблонов, неверный sha256, путь не по схеме, чужое расширение', () => {
    expect(TransferManifest.safeParse(manifest([])).success).toBe(false);
    expect(TransferManifest.safeParse(manifest([tpl({ sha256: 'ABC' })])).success).toBe(false);
    expect(
      TransferManifest.safeParse(manifest([tpl({ file: 'templates/../x/template.docx' })])).success,
    ).toBe(false);
    expect(
      TransferManifest.safeParse(manifest([tpl({ file: 'templates/1/template.xlsx' })])).success,
    ).toBe(false);
    expect(TransferManifest.safeParse(manifest([tpl({ fileExt: 'exe' as never })])).success).toBe(
      false,
    );
  });

  it('второй шаблон обязан лежать в templates/2/', () => {
    expect(TransferManifest.safeParse(manifest([tpl(), tpl()])).success).toBe(false);
    const second = tpl({ name: 'Акт', file: transferFilePath(1, 'docx') });
    expect(TransferManifest.safeParse(manifest([tpl(), second])).success).toBe(true);
  });

  it('формат вывода должен подходить расширению', () => {
    expect(TransferManifest.safeParse(manifest([tpl({ defaultOutput: 'ods' })])).success).toBe(
      false,
    );
  });

  it('запросы и параметры проверяются схемами ручного ввода', () => {
    const badKey = tpl({
      queries: [{ key: 'params', sql: 'select 1', mode: 'list', sortOrder: 0 }],
    });
    expect(TransferManifest.safeParse(manifest([badKey])).success).toBe(false);
    const badParam = tpl({
      params: [{ ...tpl().params[0]!, type: 'select', options: null }],
    });
    expect(TransferManifest.safeParse(manifest([badParam])).success).toBe(false);
    const dup = tpl({ params: [tpl().params[0]!, tpl().params[0]!] });
    expect(TransferManifest.safeParse(manifest([dup])).success).toBe(false);
    const dupQ = tpl({ queries: [tpl().queries[0]!, tpl().queries[0]!] });
    expect(TransferManifest.safeParse(manifest([dupQ])).success).toBe(false);
  });
});

describe('TransferManifest: строгость и названия', () => {
  it('неизвестное поле внутри параметра отвергается', () => {
    const p = { ...tpl().params[0]!, extra: 1 };
    expect(TransferManifest.safeParse(manifest([tpl({ params: [p] })])).success).toBe(false);
  });

  it('одинаковые названия (без учёта регистра) в одном архиве отвергаются', () => {
    const second = tpl({ name: 'СЧЁТ', file: transferFilePath(1, 'docx') });
    expect(TransferManifest.safeParse(manifest([tpl(), second])).success).toBe(false);
  });
});

describe('ExportTemplatesBody', () => {
  it('идентификаторы в верхнем регистре приводятся к нижнему', () => {
    const id = '3F2B8C1E-0D4A-4B7E-9C55-2A1F6E8D7B90';
    expect(ExportTemplatesBody.parse({ ids: [id] }).ids).toEqual([id.toLowerCase()]);
  });

  const id = '3f2b8c1e-0d4a-4b7e-9c55-2a1f6e8d7b90';
  it('1–200 идентификаторов uuid', () => {
    expect(ExportTemplatesBody.safeParse({ ids: [id] }).success).toBe(true);
    expect(ExportTemplatesBody.safeParse({ ids: [] }).success).toBe(false);
    expect(ExportTemplatesBody.safeParse({ ids: ['x'] }).success).toBe(false);
    const many = (n: number) => Array.from({ length: n }, () => id);
    expect(ExportTemplatesBody.safeParse({ ids: many(200) }).success).toBe(true);
    expect(ExportTemplatesBody.safeParse({ ids: many(201) }).success).toBe(false);
  });
});

describe('ImportDecisions', () => {
  const ID = '3F2B8C1E-0D4A-4B7E-9C55-2A1F6E8D7B90';
  it('targetId обязателен для update и запрещён для прочих действий', () => {
    const ok = ImportDecisions.parse([
      { index: 0, action: 'update', datasourceId: ID, targetId: ID },
      { index: 1, action: 'create', datasourceId: ID },
      { index: 2, action: 'skip', targetId: null },
    ]);
    expect(ok[0]!.targetId).toBe(ID.toLowerCase());
    expect(
      ImportDecisions.safeParse([{ index: 0, action: 'update', datasourceId: ID }]).success,
    ).toBe(false);
    for (const action of ['create', 'copy', 'skip'])
      expect(ImportDecisions.safeParse([{ index: 0, action, targetId: ID }]).success).toBe(false);
    expect(ImportDecisions.safeParse([{ index: 0, action: 'skip', extra: 1 }]).success).toBe(false);
  });
});
