import { describe, expect, it } from 'vitest';
import {
  allowedFormats,
  resolveRunFormat,
  runFormats,
  runStoragePath,
  snapshotExt,
  snapshotPaths,
  snapshotTemplateRef,
} from './snapshot';

const snap = {
  id: 'r1',
  status: 'ok' as const,
  snapshot: true,
  outputFormat: null,
  filePath: 'reports/r1/template.xlsx',
  fileDeleted: false,
};
const legacy = {
  id: 'r2',
  status: 'ok' as const,
  snapshot: false,
  outputFormat: 'docx' as const,
  filePath: 'reports/r2.docx',
  fileDeleted: false,
};

const errorOf = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error('исключения не было');
};
const UNAVAILABLE = {
  code: 'VALIDATION',
  status: 400,
  message: 'формат недоступен для этого отчёта',
};

describe('snapshotPaths / snapshotExt / runStoragePath', () => {
  it('всё о запуске — в reports/<runId>/', () => {
    const p = snapshotPaths('r1', 'docx');
    expect(p).toMatchObject({
      dir: 'reports/r1',
      data: 'reports/r1/data.json',
      template: 'reports/r1/template.docx',
    });
    expect(p.out('pdf')).toBe('reports/r1/out.pdf');
    expect(snapshotExt('reports/r1/template.pptx')).toBe('pptx');
  });
  it('удаляется каталог снимка или единственный файл старого запуска', () => {
    expect(runStoragePath(snap)).toBe('reports/r1');
    expect(runStoragePath(legacy)).toBe('reports/r2.docx');
  });
});

describe('resolveRunFormat', () => {
  it('снимок: без format — PDF; доступны форматы шаблона', () => {
    expect(resolveRunFormat(snap, undefined)).toBe('pdf');
    expect(resolveRunFormat(snap, 'xlsx')).toBe('xlsx');
    expect(resolveRunFormat(snap, 'ods')).toBe('ods');
  });
  it('снимок: формат вне outputFormatsFor(ext) → 400 VALIDATION', () => {
    for (const f of ['docx', 'pptx', 'exe', '']) {
      expect(errorOf(() => resolveRunFormat(snap, f))).toMatchObject(UNAVAILABLE);
    }
  });
  it('старый запуск: только output_format, он же по умолчанию', () => {
    expect(resolveRunFormat(legacy, undefined)).toBe('docx');
    expect(resolveRunFormat(legacy, 'docx')).toBe('docx');
    for (const f of ['pdf', 'odt']) {
      expect(errorOf(() => resolveRunFormat(legacy, f))).toMatchObject(UNAVAILABLE);
    }
  });
});

describe('runFormats', () => {
  it('снимок: все форматы шаблона; собранные — в порядке formats', () => {
    expect(runFormats(snap, ['xlsx', 'pdf'])).toEqual({
      formats: ['pdf', 'xlsx', 'ods'],
      readyFormats: ['pdf', 'xlsx'],
    });
  });
  it('старый запуск — только его формат, он же собран', () => {
    expect(runFormats(legacy, [])).toEqual({ formats: ['docx'], readyFormats: ['docx'] });
  });
  it('файл удалён или запуск с ошибкой — ничего', () => {
    const none = { formats: [], readyFormats: [] };
    expect(runFormats({ ...snap, fileDeleted: true }, ['pdf'])).toEqual(none);
    expect(runFormats({ ...snap, status: 'error', filePath: null }, [])).toEqual(none);
    expect(allowedFormats({ ...legacy, status: 'error' })).toEqual([]);
  });
});

describe('snapshotTemplateRef', () => {
  it('кэш Carbone ключуется по запуску; содержимое — копия из снимка', async () => {
    const file = Buffer.from('копия');
    const ref = snapshotTemplateRef('r1', 'docx', 3, file);
    expect(ref).toMatchObject({ id: 'run:r1', version: 3, ext: 'docx' });
    expect(await ref.read()).toBe(file);
  });
});
