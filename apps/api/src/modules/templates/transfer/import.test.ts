import { createHash } from 'node:crypto';
import { crc32, deflateRawSync } from 'node:zlib';
import cookie from '@fastify/cookie';
import multipartPlugin from '@fastify/multipart';
import type {
  ImportDecision,
  ImportPreviewItem,
  TransferManifest,
  TransferParam,
} from '@carbone-reports/shared/template-transfer';
import { afterEach, describe, expect, it } from 'vitest';
import { createFastify, type App, type AppDeps } from '../../../app';
import { users } from '../../../db/schema';
import { AppError, registerErrorHandler } from '../../../lib/errors';
import { makeGuards } from '../../auth/guards';
import { SESSION_COOKIE, signSession } from '../../auth/session';
import { registerTemplateRoutes } from '../routes';
import { readTransferArchive, type ArchiveLimits } from './archive';
import { buildArchive, type ArchiveItem } from './export';
import { copyName, paramErrors, planImport, resolveDecisions, type ImportLookup } from './import';

const DOC = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(60, 7)]);
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

const meta = (name: string, over: Partial<ArchiveItem['meta']> = {}): ArchiveItem['meta'] => ({
  name,
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
  queries: [],
  params: [],
  ...over,
});

const now = new Date('2026-10-10T09:00:00.000Z');
const archive = (...names: string[]) =>
  buildArchive(
    names.map((n) => ({ meta: meta(n), data: DOC })),
    { appVersion: '2.3.0', now },
  );

function manifestFor(data: Buffer[], over: Partial<TransferManifest> = {}): TransferManifest {
  return {
    format: 'carbone-reports/templates',
    formatVersion: 1,
    appVersion: '2.3.0',
    exportedAt: now.toISOString(),
    templates: data.map((d, i) => ({
      ...meta(`T${i + 1}`),
      file: `templates/${i + 1}/template.docx`,
      sha256: sha(d),
    })),
    ...over,
  };
}

interface RawEntry {
  name: string;
  data: Buffer;
  /** Заявленный в заголовке размер (по умолчанию — фактический). */
  size?: number;
  store?: boolean;
  flags?: number;
}

/** Минимальный zip без проверок — чтобы подделывать заголовки, пути и повторы имён. */
function rawZip(entries: RawEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const packed = e.store ? e.data : deflateRawSync(e.data);
    const size = e.size ?? e.data.length;
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(e.flags ?? 0x800, 6);
    lh.writeUInt16LE(e.store ? 0 : 8, 8);
    lh.writeUInt32LE(crc32(e.data), 14);
    lh.writeUInt32LE(packed.length, 18);
    lh.writeUInt32LE(size, 22);
    lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(e.flags ?? 0x800, 8);
    ch.writeUInt16LE(e.store ? 0 : 8, 10);
    ch.writeUInt32LE(crc32(e.data), 16);
    ch.writeUInt32LE(packed.length, 20);
    ch.writeUInt32LE(size, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, packed);
    centrals.push(ch, name);
    offset += 30 + name.length + packed.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const manifestEntry = (m: TransferManifest): RawEntry => ({
  name: 'manifest.json',
  data: Buffer.from(JSON.stringify(m)),
});

async function invalid(p: Promise<unknown>): Promise<string> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(AppError);
  expect((err as AppError).code).toBe('IMPORT_INVALID');
  expect((err as AppError).status).toBe(400);
  return (err as AppError).message;
}

describe('readTransferArchive', () => {
  it('архив выгрузки читается: манифест и файлы по порядку', async () => {
    const a = await readTransferArchive(await archive('Первый', 'Второй'));
    expect(a.manifest.templates.map((t) => t.name)).toEqual(['Первый', 'Второй']);
    expect(a.files).toEqual([DOC, DOC]);
  });

  it('архив больше лимита — до распаковки', async () => {
    expect(await invalid(readTransferArchive(Buffer.alloc(50 * 1024 * 1024 + 1)))).toBe(
      'архив больше 50 МБ',
    );
  });

  it('не zip и мусор — IMPORT_INVALID', async () => {
    expect(await invalid(readTransferArchive(Buffer.from('hello')))).toMatch(/не является zip/);
    const buf = await archive('A');
    expect(await invalid(readTransferArchive(buf.subarray(0, buf.length - 30)))).toMatch(
      /zip|повреждён/,
    );
  });

  it('архив-бомба: объём считается по распакованным байтам, а не по заголовкам', async () => {
    const limits: ArchiveLimits = { archiveBytes: 1 << 20, unpackedBytes: 4096, entries: 10 };
    const bomb = Buffer.alloc(100_000); // в заголовке — 64 байта
    const m = manifestFor([bomb]);
    const zip = rawZip([manifestEntry(m), { name: m.templates[0]!.file, data: bomb, size: 64 }]);
    expect(await invalid(readTransferArchive(zip, limits))).toBe('распакованный архив больше 0 МБ');
    // Суммарно по всем записям: два файла по 3 КБ не проходят лимит 4 КБ.
    const doc = Buffer.concat([DOC, Buffer.alloc(3000)]);
    const m2 = manifestFor([doc, doc]);
    const zip2 = rawZip([
      manifestEntry(m2),
      { name: m2.templates[0]!.file, data: doc },
      { name: m2.templates[1]!.file, data: doc },
    ]);
    await invalid(readTransferArchive(zip2, { ...limits, unpackedBytes: 6000 }));
    expect(
      (await readTransferArchive(zip2, { ...limits, unpackedBytes: 1 << 20 })).files,
    ).toHaveLength(2);
  });

  it('заявленный размер не совпадает с фактическим — архив повреждён', async () => {
    const m = manifestFor([DOC]);
    const zip = rawZip([manifestEntry(m), { name: m.templates[0]!.file, data: DOC, size: 3 }]);
    expect(await invalid(readTransferArchive(zip))).toMatch(/повреждён/);
  });

  it('больше 1000 записей — до распаковки', async () => {
    const entries = Array.from({ length: 1001 }, (_, i) => ({
      name: `x${i}`,
      data: Buffer.alloc(0),
    }));
    expect(await invalid(readTransferArchive(rawZip(entries)))).toBe(
      'в архиве больше 1000 записей',
    );
  });

  it.each(['../evil', '/etc/passwd', 'templates/../manifest.json', 'a\\b', 'C:/x', 'templates//1'])(
    'путь %s — отказ',
    async (name) => {
      const m = manifestFor([DOC]);
      const zip = rawZip([
        manifestEntry(m),
        { name: m.templates[0]!.file, data: DOC },
        { name, data: DOC },
      ]);
      expect(await invalid(readTransferArchive(zip))).toMatch(/недопустимый путь/);
    },
  );

  it('лишний файл, лишний каталог, повтор записи, нет файла шаблона, нет манифеста', async () => {
    const m = manifestFor([DOC]);
    const f = { name: m.templates[0]!.file, data: DOC };
    expect(
      await invalid(
        readTransferArchive(rawZip([manifestEntry(m), f, { name: 'extra.txt', data: DOC }])),
      ),
    ).toBe('лишний файл в архиве: extra.txt');
    expect(
      await invalid(
        readTransferArchive(
          rawZip([manifestEntry(m), f, { name: '__MACOSX/', data: Buffer.alloc(0) }]),
        ),
      ),
    ).toMatch(/лишний файл/);
    expect(await invalid(readTransferArchive(rawZip([manifestEntry(m), f, f])))).toMatch(
      /повторяется/,
    );
    expect(await invalid(readTransferArchive(rawZip([manifestEntry(m)])))).toMatch(/нет файла/);
    expect(await invalid(readTransferArchive(rawZip([f])))).toMatch(/нет manifest.json/);
  });

  it('пустые каталоги templates/ и templates/<n>/ допускаются', async () => {
    const m = manifestFor([DOC]);
    const zip = rawZip([
      { name: 'templates/', data: Buffer.alloc(0), store: true },
      { name: 'templates/1/', data: Buffer.alloc(0), store: true },
      manifestEntry(m),
      { name: m.templates[0]!.file, data: DOC, store: true },
    ]);
    expect((await readTransferArchive(zip)).files).toEqual([DOC]);
  });

  it('подменённый файл шаблона — sha256 не совпадает', async () => {
    const m = manifestFor([DOC]);
    const other = Buffer.concat([DOC, Buffer.from('x')]);
    const zip = rawZip([manifestEntry(m), { name: m.templates[0]!.file, data: other }]);
    expect(await invalid(readTransferArchive(zip))).toMatch(/контрольной суммой/);
  });

  it('файл шаблона не Office (не zip) — отказ', async () => {
    const txt = Buffer.from('plain text');
    const m = manifestFor([txt]);
    const zip = rawZip([manifestEntry(m), { name: m.templates[0]!.file, data: txt }]);
    expect(await invalid(readTransferArchive(zip))).toMatch(/не является документом Office/);
  });

  it('зашифрованная запись — отказ', async () => {
    const m = manifestFor([DOC]);
    const zip = rawZip([manifestEntry(m), { name: m.templates[0]!.file, data: DOC, flags: 0x801 }]);
    expect(await invalid(readTransferArchive(zip))).toMatch(/зашифрованные/);
  });

  it('formatVersion, format, JSON и схема манифеста', async () => {
    const f = { name: 'templates/1/template.docx', data: DOC };
    const withManifest = (m: unknown) =>
      readTransferArchive(
        rawZip([{ name: 'manifest.json', data: Buffer.from(JSON.stringify(m)) }, f]),
      );
    const m = manifestFor([DOC]);
    expect(await invalid(withManifest({ ...m, formatVersion: 2 }))).toMatch(
      /версия формата архива 2/,
    );
    expect(await invalid(withManifest({ ...m, format: 'zip' }))).toBe(
      'это не архив шаблонов carbone-reports',
    );
    expect(
      await invalid(
        readTransferArchive(rawZip([{ name: 'manifest.json', data: Buffer.from('{') }, f])),
      ),
    ).toMatch(/неверный JSON/);
    const bad = structuredClone(m);
    (bad.templates[0] as { fileExt: string }).fileExt = 'exe';
    expect(await invalid(withManifest(bad))).toMatch(/^manifest.json: шаблон 1 \(fileExt\)/);
    const badKey = structuredClone(m);
    badKey.templates[0]!.queries = [
      { key: 'не ключ', sql: 'select 1', mode: 'list', sortOrder: 0 },
    ];
    expect(await invalid(withManifest(badKey))).toMatch(/латиница/);
    const badPath = structuredClone(m);
    badPath.templates[0]!.file = 'templates/2/template.docx';
    expect(await invalid(withManifest(badPath))).toMatch(/ожидается путь/);
  });
});

// ---- План и решения ----

const param = (p: Partial<TransferParam> & { name: string }): TransferParam =>
  ({
    label: p.name,
    type: 'string',
    required: false,
    defaultValue: null,
    options: null,
    sql: null,
    multiple: false,
    sortOrder: 0,
    ...p,
  }) as TransferParam;

describe('paramErrors', () => {
  it('проверки PUT .../params: неизвестная ссылка и неверное значение по умолчанию', () => {
    expect(paramErrors([param({ name: 'a' })])).toEqual([]);
    expect(paramErrors([param({ name: 'a', type: 'query', sql: 'select :zzz' })])).toEqual([
      'параметр «a»: неизвестный параметр :zzz',
    ]);
    expect(paramErrors([param({ name: 'n', type: 'number', defaultValue: 'abc' })])[0]).toMatch(
      /^параметр «n»: значение по умолчанию/,
    );
  });
});

const lookup = (over: Partial<ImportLookup> = {}): ImportLookup => ({
  templatesByName: new Map(),
  datasourcesByName: new Map(),
  groupsByLower: new Map(),
  categoriesByLower: new Map(),
  ...over,
});

describe('planImport', () => {
  const m = manifestFor([DOC, DOC]);
  m.templates[0] = { ...m.templates[0]!, category: 'Финансы', groups: ['Бухгалтерия', 'Склад'] };

  it('совпадение имени, источник по имени, нет групп, нет категории', () => {
    const plan = planImport(
      m,
      lookup({
        templatesByName: new Map([
          [
            'T1',
            [
              { id: 'e1', name: 'T1' },
              { id: 'e0', name: 'T1' },
            ],
          ],
        ]),
        datasourcesByName: new Map([['src', ['ds1']]]),
        groupsByLower: new Map([['бухгалтерия', 'g1']]),
      }),
    );
    expect(plan[0]).toMatchObject({
      index: 0,
      name: 'T1',
      existing: { id: 'e1', name: 'T1' },
      datasourceMatch: 'ds1',
      category: 'Финансы',
      categoryExists: false,
      missingGroups: ['Склад'],
      errors: [],
    });
    expect(plan[1]).toMatchObject({ existing: null, categoryExists: true, missingGroups: [] });
    expect(plan[0]!.datasource).toEqual(m.templates[0]!.datasource);
  });

  it('несколько источников с тем же именем — нужен выбор; категория без учёта регистра', () => {
    const plan = planImport(
      m,
      lookup({
        datasourcesByName: new Map([['src', ['ds1', 'ds2']]]),
        categoriesByLower: new Map([['финансы', 'c1']]),
      }),
    );
    expect(plan[0]).toMatchObject({ datasourceMatch: null, categoryExists: true });
  });
});

describe('copyName', () => {
  it('первое свободное число с 2', () => {
    expect(copyName('A', new Set(['A']))).toBe('A (2)');
    expect(copyName('A', new Set(['A', 'A (2)', 'A (4)']))).toBe('A (3)');
  });
});

describe('resolveDecisions', () => {
  const DS = '3f2b8c1e-0d4a-4b7e-9c55-2a1f6e8d7b90';
  const item = (index: number, name: string, over: Partial<ImportPreviewItem> = {}) =>
    ({ index, name, existing: null, errors: [], ...over }) as ImportPreviewItem;
  const ctx = (taken: string[] = []) => ({
    datasourceIds: new Set([DS]),
    takenNames: new Set(taken),
  });
  const d = (
    index: number,
    action: ImportDecision['action'],
    datasourceId: string | null = DS,
  ) => ({
    index,
    action,
    datasourceId,
  });
  const fails = (fn: () => unknown, re: RegExp, code = 'BAD_REQUEST') => {
    try {
      fn();
    } catch (e) {
      expect((e as AppError).code).toBe(code);
      expect((e as AppError).status).toBe(400);
      expect((e as AppError).message).toMatch(re);
      return;
    }
    throw new Error('ожидалась ошибка');
  };

  it('create, update, copy с «(2)»/«(3)», skip', () => {
    const plan = [
      item(0, 'Новый'),
      item(1, 'Есть', { existing: { id: 'e1', name: 'Есть' } }),
      item(2, 'Есть', { existing: { id: 'e1', name: 'Есть' } }),
      item(3, 'Есть', { existing: { id: 'e1', name: 'Есть' } }),
      item(4, 'Любой'),
    ];
    const r = resolveDecisions(
      plan,
      [d(0, 'create'), d(1, 'update'), d(2, 'copy'), d(3, 'copy'), d(4, 'skip', null)],
      ctx(['Есть']),
    );
    expect(r.map((x) => [x.action, x.name, x.targetId])).toEqual([
      ['create', 'Новый', null],
      ['update', 'Есть', 'e1'],
      ['copy', 'Есть (2)', null],
      ['copy', 'Есть (3)', null],
      ['skip', 'Любой', null],
    ]);
  });

  it('нет datasourceId — 400; неизвестный источник — 400; skip без источника — можно', () => {
    fails(
      () => resolveDecisions([item(0, 'A')], [d(0, 'create', null)], ctx()),
      /выберите источник/,
    );
    fails(
      () =>
        resolveDecisions(
          [item(0, 'A')],
          [d(0, 'create', '00000000-0000-4000-8000-000000000000')],
          ctx(),
        ),
      /источник данных не найден/,
    );
    expect(resolveDecisions([item(0, 'A')], [d(0, 'skip', null)], ctx())[0]!.action).toBe('skip');
  });

  it('create при существующем имени — 400, в том числе созданном раньше в этом же архиве', () => {
    fails(() => resolveDecisions([item(0, 'A')], [d(0, 'create')], ctx(['A'])), /уже есть/);
    fails(
      () => resolveDecisions([item(0, 'A'), item(1, 'A')], [d(0, 'create'), d(1, 'create')], ctx()),
      /уже есть/,
    );
  });

  it('update без совпадения, дважды один шаблон, нет решения, повтор, чужой номер', () => {
    fails(() => resolveDecisions([item(0, 'A')], [d(0, 'update')], ctx()), /обновлять нечего/);
    const ex = { existing: { id: 'e1', name: 'A' } };
    fails(
      () =>
        resolveDecisions(
          [item(0, 'A', ex), item(1, 'A', ex)],
          [d(0, 'update'), d(1, 'update')],
          ctx(),
        ),
      /дважды/,
    );
    fails(
      () => resolveDecisions([item(0, 'A'), item(1, 'B')], [d(0, 'create')], ctx()),
      /не выбрано действие/,
    );
    fails(
      () => resolveDecisions([item(0, 'A')], [d(0, 'create'), d(0, 'skip')], ctx()),
      /повторяется/,
    );
    fails(
      () => resolveDecisions([item(0, 'A')], [d(0, 'create'), d(5, 'skip')], ctx()),
      /нет шаблона/,
    );
  });

  it('шаблон с ошибками проверки можно только пропустить', () => {
    const bad = item(0, 'A', { errors: ['параметр «a»: плохо'] });
    fails(() => resolveDecisions([bad], [d(0, 'create')], ctx()), /плохо/, 'IMPORT_INVALID');
    expect(resolveDecisions([bad], [d(0, 'skip')], ctx())[0]!.action).toBe('skip');
  });
});

// ---- Маршруты: охрана и разбор тела (данные — в test/template-transfer.int.test.ts) ----

const SECRET = new TextEncoder().encode('test-secret-test-secret-test-secret');

function fakeDb(role: 'admin' | 'user') {
  const chain = (rows: unknown[]) => {
    const c: Record<string, unknown> = {};
    for (const m of ['innerJoin', 'leftJoin', 'where', 'orderBy']) c[m] = () => c;
    c.then = (res: (v: unknown) => unknown) => Promise.resolve(rows).then(res);
    return c;
  };
  return {
    select: () => ({
      from: (t: unknown) =>
        chain(
          t === users ? [{ id: 'u1', login: 'a', role, blocked: false, sessionVersion: 1 }] : [],
        ),
    }),
  };
}

function form(fields: Record<string, string>, file?: Buffer) {
  const boundary = '----b';
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) {
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`),
    );
  }
  if (file) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.crt.zip"\r\nContent-Type: application/zip\r\n\r\n`,
      ),
      file,
      Buffer.from('\r\n'),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    payload: Buffer.concat(parts),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

describe('POST /api/templates/import[/preview]', () => {
  let app: App | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function call(role: 'admin' | 'user' | null, url: string, body: ReturnType<typeof form>) {
    const deps = {
      config: { appSecret: SECRET },
      db: fakeDb(role ?? 'user'),
    } as unknown as AppDeps;
    app = createFastify();
    registerErrorHandler(app);
    await app.register(cookie);
    await app.register(multipartPlugin, { limits: { fileSize: 20 * 1024 * 1024, files: 1 } });
    registerTemplateRoutes(app, deps, makeGuards(deps));
    await app.ready();
    const headers: Record<string, string> = { ...body.headers };
    if (role) {
      const token = await signSession({ id: 'u1', login: 'a', role }, 1, SECRET);
      headers.cookie = `${SESSION_COOKIE}=${token}`;
    }
    const r = await app.inject({ method: 'POST', url, headers, payload: body.payload });
    await app.close();
    app = undefined;
    return r;
  }

  it('без сессии — 401, не администратор — 403', async () => {
    const body = form({}, await archive('A'));
    for (const url of ['/api/templates/import/preview', '/api/templates/import']) {
      expect((await call(null, url, body)).statusCode).toBe(401);
      expect((await call('user', url, body)).statusCode).toBe(403);
    }
  });

  it('без файла — 400; неверный архив — 400 IMPORT_INVALID', async () => {
    expect((await call('admin', '/api/templates/import/preview', form({}))).statusCode).toBe(400);
    const r = await call('admin', '/api/templates/import/preview', form({}, Buffer.from('nope')));
    expect(r.statusCode).toBe(400);
    expect(r.json().error.code).toBe('IMPORT_INVALID');
  });

  it('архив больше 20 МБ (общий лимит multipart) принимается до 50 МБ, больше — IMPORT_INVALID', async () => {
    const big = Buffer.alloc(50 * 1024 * 1024 + 10);
    const r = await call('admin', '/api/templates/import/preview', form({}, big));
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatchObject({ code: 'IMPORT_INVALID', message: 'архив больше 50 МБ' });
    const mid = await call(
      'admin',
      '/api/templates/import/preview',
      form({}, Buffer.alloc(30 * 1024 * 1024)),
    );
    expect(mid.json().error).toMatchObject({
      code: 'IMPORT_INVALID',
      message: 'файл не является zip-архивом',
    });
  });

  it('decisions: нет, не JSON, не по схеме — 400 до разбора архива', async () => {
    const zip = await archive('A');
    for (const fields of [
      {} as Record<string, string>,
      { decisions: '{' },
      { decisions: '[]' },
      { decisions: '[{"index":0,"action":"drop"}]' },
    ]) {
      const r = await call('admin', '/api/templates/import', form(fields, zip));
      expect(r.statusCode).toBe(400);
      expect(r.json().error.code).toBe('BAD_REQUEST');
    }
  });
});
