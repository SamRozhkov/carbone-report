import { describe, expect, it } from 'vitest';
import {
  DatasourceBody,
  sqlCompareRefs,
  ParamsInput,
  RenderBody,
  TemplateParam,
  TemplateQuery,
  outputFormatsFor,
  BACKUP_NAME_RE,
  RecoveryBody,
  DOC_SNAPSHOT_LIMITS,
  DocSnapshot,
  EditorDraft,
} from './index';
import { createTranslator } from './i18n/server';
import { TransferParam, TransferQuery } from './template-transfer';

/** Сообщение zod по-русски: ключ `v:…` — из каталога validation. */
const ruMessage = (i: { message: string; params?: Record<string, unknown> }) =>
  i.message.startsWith('v:')
    ? createTranslator('ru')(`validation:${i.message.slice(2)}`, i.params)
    : i.message;

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
    expect(ruMessage(r.error!.issues[0] as never)).toBe('зарезервированное имя');
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
  const q = {
    name: 'city',
    label: 'Город',
    type: 'query',
    required: false,
    defaultValue: null,
    options: null,
  };
  it('query требует непустой sql; options запрещены', () => {
    expect(TemplateParam.safeParse({ ...q, sql: 'select 1' }).success).toBe(true);
    expect(TemplateParam.safeParse({ ...q, sql: '  ' }).success).toBe(false);
    expect(TemplateParam.safeParse({ ...q }).success).toBe(false);
    expect(
      TemplateParam.safeParse({ ...q, sql: 'select 1', options: [{ value: 'a', label: 'a' }] })
        .success,
    ).toBe(false);
  });
  it('sql и multiple допустимы только у query', () => {
    const s = {
      name: 's',
      label: 'S',
      type: 'string',
      required: false,
      defaultValue: null,
      options: null,
    };
    expect(TemplateParam.parse(s)).toMatchObject({ sql: null, multiple: false });
    expect(TemplateParam.safeParse({ ...s, sql: 'select 1' }).success).toBe(false);
    expect(TemplateParam.safeParse({ ...s, multiple: true }).success).toBe(false);
  });
  it('значение по умолчанию: массив только у multiple', () => {
    expect(
      TemplateParam.safeParse({ ...q, sql: 'select 1', multiple: true, defaultValue: [1, 'a'] })
        .success,
    ).toBe(true);
    expect(TemplateParam.safeParse({ ...q, sql: 'select 1', defaultValue: [1] }).success).toBe(
      false,
    );
  });
  it('ParamsInput принимает массивы скаляров, но не boolean в массиве', () => {
    expect(ParamsInput.parse({ ids: [1, 2], s: 'x' })).toEqual({ ids: [1, 2], s: 'x' });
    expect(ParamsInput.safeParse({ ids: [true] }).success).toBe(false);
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

describe('RenderBody', () => {
  it('формата в теле больше нет: пришедший format отбрасывается (§24.4)', () => {
    expect(RenderBody.parse({ params: { a: 1 }, format: 'docx' })).toEqual({ params: { a: 1 } });
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

describe('sqlCompareRefs', () => {
  const r = sqlCompareRefs;
  it('скалярное сравнение и ровно any(:имя)', () => {
    expect(r('where a = :a and b >= :b and c != :c and d = any(:d)')).toEqual({
      scalar: ['a', 'b', 'c'],
      any: ['d'],
      missingOperator: false,
    });
  });
  it('массивные формы не считаются скалярным сравнением', () => {
    const x = r(
      'where a <> all(:a) and b in (select unnest(:b)) and c = any(:c::int[]) and :d && e',
    );
    expect(x.scalar).toEqual([]);
    expect(x.any).toEqual([]);
    expect(r('where a = :a::int[]').scalar).toEqual([]);
    expect(r('where a = :a::int').scalar).toEqual(['a']);
    expect(r('where a = :a::int and b[1] = 1').scalar).toEqual(['a']);
    expect(r('where tags @> :t and data -> :k is not null and j #> :p = 1').scalar).toEqual([]);
  });
  it('комментарии, строки и идентификаторы в кавычках пропускаются', () => {
    const x = r(`where a = any(:a) -- = :a\n /* = :b */ and s = '= :c' and "x = :d" = 1`);
    expect(x).toEqual({ scalar: [], any: ['a'], missingOperator: false });
  });
  it('any без оператора', () => {
    expect(r('where a any(:a)').missingOperator).toBe(true);
    expect(r('where a in any(:a)').missingOperator).toBe(true);
    expect(r('where a = any(:a)').missingOperator).toBe(false);
    expect(r('where a = ANY (:a)').missingOperator).toBe(false);
    expect(r('where a like any(:a) or b ilike any(:b)').missingOperator).toBe(false);
  });
});

describe('бэкапы', () => {
  it('BACKUP_NAME_RE — шаблон имени из §26.1', () => {
    expect(BACKUP_NAME_RE.test('2026-10-08T03-00-00Z')).toBe(true);
    expect(BACKUP_NAME_RE.test('pre-restore-2026-10-08T03-00-00Z')).toBe(true);
    for (const bad of ['2026-10-08T03-00-00Z.partial', '../x', '2026-10-08 03-00-00Z', ''])
      expect(BACKUP_NAME_RE.test(bad)).toBe(false);
  });
  it('RecoveryBody: код и цель same | pre-restore', () => {
    expect(RecoveryBody.parse({ code: ' ABCD-EFGH-IJKL ', target: 'same' })).toEqual({
      code: 'ABCD-EFGH-IJKL',
      target: 'same',
    });
    expect(RecoveryBody.safeParse({ code: '', target: 'same' }).success).toBe(false);
    expect(RecoveryBody.safeParse({ code: 'X', target: 'other' }).success).toBe(false);
  });
});

describe('только чтение в схемах (§47.2)', () => {
  const issueOf = (r: {
    success: boolean;
    error?: { issues: { path: PropertyKey[]; message: string; params?: unknown }[] };
  }) => r.error?.issues.map((i) => ({ path: i.path, message: i.message, params: i.params }));

  it('TemplateQuery: изменяющий SQL — issue у sql с found', () => {
    const r = TemplateQuery.safeParse({ key: 'q', sql: 'update t set a = 1', mode: 'list' });
    expect(issueOf(r)).toEqual([
      { path: ['sql'], message: 'v:sql.readOnlyOnly', params: { found: 'UPDATE' } },
    ]);
  });

  it('TemplateQuery: пустой SQL — только прежняя ошибка min(1), без второй', () => {
    const r = TemplateQuery.safeParse({ key: 'q', sql: '   ', mode: 'list' });
    expect(r.success).toBe(false);
    expect(r.error!.issues.every((i) => i.message !== 'v:sql.readOnlyOnly')).toBe(true);
  });

  it('TemplateParam query: запрещённая функция — issue у sql', () => {
    const r = TemplateParam.safeParse({
      name: 'p',
      label: 'P',
      type: 'query',
      required: false,
      defaultValue: null,
      options: null,
      sql: "select nextval('s') as value",
      multiple: false,
    });
    expect(issueOf(r)).toEqual([
      { path: ['sql'], message: 'v:sql.readOnlyOnly', params: { found: 'nextval' } },
    ]);
  });

  it('TemplateParam query: пустой SQL — только sqlRequired', () => {
    const r = TemplateParam.safeParse({
      name: 'p',
      label: 'P',
      type: 'query',
      required: false,
      defaultValue: null,
      options: null,
      sql: ' ',
      multiple: false,
    });
    expect(r.error!.issues.map((i) => i.message)).toEqual(['v:param.sqlRequired']);
  });

  it('TransferQuery и TransferParam наследуют правило', () => {
    expect(
      TransferQuery.safeParse({ key: 'q', sql: 'delete from t', mode: 'list', sortOrder: 0 })
        .success,
    ).toBe(false);
    expect(
      TransferParam.safeParse({
        name: 'p',
        label: 'P',
        type: 'query',
        required: false,
        defaultValue: null,
        options: null,
        sql: 'select pg_sleep(1)',
        multiple: false,
        sortOrder: 0,
      }).success,
    ).toBe(false);
  });
});

describe('DocSnapshot (§52.3)', () => {
  const ok = {
    blocks: [
      { type: 'p', text: 'Счёт № {d.number}', area: 'body' },
      {
        type: 'table',
        rows: [
          ['Товар', 'Цена'],
          ['{d.items[i].name}', '{d.items[i].price}'],
        ],
        area: 'body',
      },
      { type: 'p', text: 'Стр.', area: 'footer' },
    ],
    truncated: false,
  };
  it('принимает абзац, таблицу и колонтитул', () => {
    expect(DocSnapshot.safeParse(ok).success).toBe(true);
  });
  it('отклоняет 31 таблицу', () => {
    const t = { type: 'table', rows: [['a']], area: 'body' };
    expect(DocSnapshot.safeParse({ blocks: Array(31).fill(t), truncated: false }).success).toBe(
      false,
    );
    expect(DocSnapshot.safeParse({ blocks: Array(30).fill(t), truncated: false }).success).toBe(
      true,
    );
  });
  it('отклоняет ячейку в 501 символ', () => {
    const cell = (n: number) => ({
      blocks: [{ type: 'table', rows: [['x'.repeat(n)]], area: 'body' }],
      truncated: false,
    });
    expect(DocSnapshot.safeParse(cell(501)).success).toBe(false);
    expect(DocSnapshot.safeParse(cell(500)).success).toBe(true);
  });
  it('отклоняет сумму символов 30 001', () => {
    const p = (n: number) => ({ type: 'p', text: 'x'.repeat(n), area: 'body' });
    expect(DocSnapshot.safeParse({ blocks: [p(20_000), p(10_001)], truncated: true }).success).toBe(
      false,
    );
    expect(DocSnapshot.safeParse({ blocks: [p(20_000), p(10_000)], truncated: true }).success).toBe(
      true,
    );
  });
  it('не больше 2000 блоков и 500 строк в таблице (общие лимиты DOC_SNAPSHOT_LIMITS)', () => {
    expect(DOC_SNAPSHOT_LIMITS).toMatchObject({ blocks: 2000, rows: 500, chars: 30_000 });
    const p = { type: 'p', text: 'x', area: 'body' };
    expect(DocSnapshot.safeParse({ blocks: Array(2001).fill(p), truncated: true }).success).toBe(
      false,
    );
    expect(DocSnapshot.safeParse({ blocks: Array(2000).fill(p), truncated: true }).success).toBe(
      true,
    );
    const table = (n: number) => ({
      blocks: [{ type: 'table', rows: Array(n).fill(['a']), area: 'body' }],
      truncated: true,
    });
    expect(DocSnapshot.safeParse(table(501)).success).toBe(false);
    expect(DocSnapshot.safeParse(table(500)).success).toBe(true);
  });
  it('пустой абзац и пустая ячейка считаются за 1 символ', () => {
    const empty = { type: 'p', text: '', area: 'body' };
    const full = { type: 'p', text: 'x'.repeat(29_000), area: 'body' };
    expect(
      DocSnapshot.safeParse({ blocks: [full, ...Array(1000).fill(empty)], truncated: true })
        .success,
    ).toBe(true);
    expect(
      DocSnapshot.safeParse({ blocks: [full, ...Array(1001).fill(empty)], truncated: true })
        .success,
    ).toBe(false);
    const cells = (n: number) => ({
      blocks: [
        full,
        { type: 'table', rows: Array(n / 10).fill(Array(10).fill('')), area: 'body' },
      ],
      truncated: true,
    });
    expect(DocSnapshot.safeParse(cells(1000)).success).toBe(true);
    expect(DocSnapshot.safeParse(cells(1010)).success).toBe(false);
  });
  it('EditorDraft без document валиден, с document и documentAutomation — тоже', () => {
    const base = { queries: [], params: [] };
    expect(EditorDraft.safeParse(base).success).toBe(true);
    expect(EditorDraft.safeParse({ ...base, document: ok, documentAutomation: true }).success).toBe(
      true,
    );
    expect(EditorDraft.safeParse({ ...base, documentAutomation: false }).success).toBe(false);
  });
});
