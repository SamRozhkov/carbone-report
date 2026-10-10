import { createHash } from 'node:crypto';
import cookie from '@fastify/cookie';
import { TransferManifest, type TransferTemplate } from '@carbone-reports/shared/template-transfer';
import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';
import { createFastify, type App, type AppDeps } from '../../../app';
import { users } from '../../../db/schema';
import { registerErrorHandler } from '../../../lib/errors';
import { makeGuards } from '../../auth/guards';
import { SESSION_COOKIE, signSession } from '../../auth/session';
import { registerTemplateRoutes } from '../routes';
import {
  buildArchive,
  exportFileName,
  localDate,
  MAX_CONCURRENT_EXPORTS,
  withExportSlot,
  type ArchiveItem,
} from './export';

const meta = (name: string): ArchiveItem['meta'] => ({
  name,
  description: 'd',
  fileExt: 'docx',
  defaultOutput: 'pdf',
  public: true,
  category: 'Финансы',
  groups: ['Бухгалтерия'],
  datasource: {
    name: 'src',
    host: 'db',
    port: 5432,
    database: 'app',
    username: 'ro',
    sslMode: 'verify',
  },
  queries: [{ key: 'rows', sql: 'select 1', mode: 'list', sortOrder: 0 }],
  params: [],
});

describe('exportFileName', () => {
  it('имя шаблона + .crt.zip, кириллица сохраняется', () => {
    expect(exportFileName('Счёт на оплату')).toBe('Счёт_на_оплату.crt.zip');
  });
  it('недопустимые символы и пути заменяются, точки по краям убираются', () => {
    expect(exportFileName('../a/b:c*?"<>|\\d')).toBe('a_b_c_d.crt.zip');
    expect(exportFileName('..hidden.')).toBe('hidden.crt.zip');
  });
  it('пустое после очистки — template, длина ограничена', () => {
    expect(exportFileName('///')).toBe('template.crt.zip');
    expect(exportFileName('x'.repeat(300)).length).toBe(100 + '.crt.zip'.length);
  });
});

describe('exportFileName: зарезервированные имена', () => {
  it('CON, nul.txt, COM1 получают префикс', () => {
    expect(exportFileName('CON')).toBe('_CON.crt.zip');
    expect(exportFileName('nul')).toBe('_nul.crt.zip');
    expect(exportFileName('Console')).toBe('Console.crt.zip');
  });
});

describe('withExportSlot', () => {
  it('одновременно выполняется не больше MAX_CONCURRENT_EXPORTS, остальные ждут', async () => {
    let active = 0;
    let peak = 0;
    const gates: Array<() => void> = [];
    const task = () =>
      withExportSlot(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise<void>((r) => gates.push(r));
        active--;
      });
    const all = Promise.all([task(), task(), task(), task()]);
    await new Promise((r) => setTimeout(r, 10));
    expect(active).toBe(MAX_CONCURRENT_EXPORTS);
    while (gates.length) {
      gates.shift()!();
      await new Promise((r) => setTimeout(r, 5));
    }
    await all;
    expect(peak).toBe(MAX_CONCURRENT_EXPORTS);
    expect(active).toBe(0);
  });

  it('слот освобождается и после ошибки', async () => {
    await expect(withExportSlot(async () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    await expect(withExportSlot(async () => 1)).resolves.toBe(1);
  });
});

describe('localDate', () => {
  it('дата в часовом поясе приложения', () => {
    const now = new Date('2026-10-10T22:30:00Z');
    expect(localDate(now, 'UTC')).toBe('2026-10-10');
    expect(localDate(now, 'Europe/Moscow')).toBe('2026-10-11');
  });
});

describe('buildArchive: сжатие', () => {
  it('файлы шаблонов хранятся без сжатия, манифест сжимается', async () => {
    const data = Buffer.alloc(1_000_000, 0x41);
    const buf = await buildArchive([{ meta: meta('T'), data }], {
      appVersion: 'dev',
      now: new Date(),
    });
    expect(buf.length).toBeGreaterThan(data.length);
  });
});

describe('buildArchive', () => {
  const now = new Date('2026-10-10T09:00:00.000Z');

  it('архив, который не загрузится, не выгружается: 400 с именем шаблона', async () => {
    const long = 'Д'.repeat(300);
    const err = await buildArchive([{ meta: meta(long), data: Buffer.from('PK') }], {
      appVersion: 'dev',
      now,
    }).then(
      () => null,
      (e: unknown) => e as { status: number; message: string },
    );
    expect(err?.status).toBe(400);
    expect(err?.message).toMatch(new RegExp(`^шаблон «${long}» нельзя выгрузить \\(name\\)`));
  });

  it('manifest.json и файлы templates/<n>/template.<ext> с sha256', async () => {
    const a = Buffer.from('PK-a');
    const b = Buffer.from('PK-bb');
    const buf = await buildArchive(
      [
        { meta: meta('Первый'), data: a },
        { meta: meta('Второй'), data: b },
      ],
      { appVersion: '2.3.0', now },
    );
    const zip = await JSZip.loadAsync(buf);
    expect(Object.keys(zip.files).sort()).toEqual([
      'manifest.json',
      'templates/1/template.docx',
      'templates/2/template.docx',
    ]);
    const m = TransferManifest.parse(JSON.parse(await zip.file('manifest.json')!.async('string')));
    expect(m.appVersion).toBe('2.3.0');
    expect(m.exportedAt).toBe(now.toISOString());
    expect(m.templates.map((t) => t.name)).toEqual(['Первый', 'Второй']);
    expect(m.templates[0]!.sha256).toBe(createHash('sha256').update(a).digest('hex'));
    expect(m.templates[1]!.file).toBe('templates/2/template.docx');
    expect(Buffer.from(await zip.file('templates/2/template.docx')!.async('uint8array'))).toEqual(
      b,
    );
  });

  it('в манифесте только поля §33.1: нет паролей, CA, идентификаторов и дат', async () => {
    const buf = await buildArchive([{ meta: meta('T'), data: Buffer.from('PK') }], {
      appVersion: 'dev',
      now,
    });
    const text = await (await JSZip.loadAsync(buf)).file('manifest.json')!.async('string');
    const t = JSON.parse(text).templates[0] as TransferTemplate;
    expect(Object.keys(t).sort()).toEqual(
      [
        'category',
        'datasource',
        'defaultOutput',
        'description',
        'file',
        'fileExt',
        'groups',
        'name',
        'params',
        'public',
        'queries',
        'sha256',
      ].sort(),
    );
    expect(Object.keys(t.datasource).sort()).toEqual(
      ['database', 'host', 'name', 'port', 'sslMode', 'username'].sort(),
    );
    expect(text).not.toMatch(/password|sslCa|passwordEnc|updatedAt|updatedBy|"id"/i);
  });
});

// ---- Маршрут POST /api/templates/export: охрана и проверка тела (данные — в test/templates-export.int.test.ts) ----

const SECRET = new TextEncoder().encode('test-secret-test-secret-test-secret');
const ID = '3f2b8c1e-0d4a-4b7e-9c55-2a1f6e8d7b90';

/** Заглушка БД: пользователь из users, любой другой select — пустой. */
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

describe('POST /api/templates/export', () => {
  let app: App | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function call(
    role: 'admin' | 'user' | null,
    payload: object,
  ): Promise<{ statusCode: number; json(): { error: { code: string } } }> {
    const deps = {
      config: { appSecret: SECRET, appVersion: 'dev', tz: 'UTC' },
      db: fakeDb(role ?? 'user'),
    } as unknown as AppDeps;
    app = createFastify();
    registerErrorHandler(app);
    await app.register(cookie);
    registerTemplateRoutes(app, deps, makeGuards(deps));
    await app.ready();
    const headers: Record<string, string> = {};
    if (role) {
      const token = await signSession({ id: 'u1', login: 'a', role }, 1, SECRET);
      headers.cookie = `${SESSION_COOKIE}=${token}`;
    }
    return await app.inject({ method: 'POST', url: '/api/templates/export', headers, payload });
  }

  it('без сессии — 401, не администратор — 403', async () => {
    expect((await call(null, { ids: [ID] })).statusCode).toBe(401);
    expect((await call('user', { ids: [ID] })).statusCode).toBe(403);
  });

  it('пустой список, не uuid и более 200 идентификаторов — 400', async () => {
    expect((await call('admin', { ids: [] })).statusCode).toBe(400);
    await app?.close();
    expect((await call('admin', { ids: ['x'] })).statusCode).toBe(400);
    await app?.close();
    expect((await call('admin', { ids: Array.from({ length: 201 }, () => ID) })).statusCode).toBe(
      400,
    );
  });

  it('несуществующий id — 404 NOT_FOUND', async () => {
    const r = await call('admin', { ids: [ID] });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe('NOT_FOUND');
  });
});
