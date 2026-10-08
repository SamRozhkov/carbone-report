import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { LocalStorage, type RemoveGate, type Storage } from '../src/lib/storage';
import { createRemoveGate, STORAGE_REMOVE_LOCK_KEY } from '../src/lib/storage-gate';
import { createTestDatabase } from './helpers';

/** Контракт Storage (§25.5): один набор для каждой реализации. */
interface Backend {
  name: 'local' | 's3';
  open(gate?: RemoveGate): Promise<{ storage: Storage; close(): Promise<void> }>;
}

const local: Backend = {
  name: 'local',
  async open(gate) {
    const dir = await mkdtemp(join(tmpdir(), 'cr-contract-'));
    return {
      storage: new LocalStorage(dir, gate),
      close: () => rm(dir, { recursive: true, force: true }),
    };
  },
};

const backends: Backend[] = [local];

const INVALID_KEYS = ['', '/abs/x', '../x', 'a/../b', '..', '.', 'a/./b', 'a\\b', 'a//b', 'a/'];

/** Параллельно, но не больше size запросов сразу. */
async function inBatches<T>(
  items: string[],
  fn: (item: string) => Promise<T>,
  size = 50,
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

let pool: pg.Pool;
let holder: pg.Client;
beforeAll(async () => {
  const url = await createTestDatabase();
  pool = new pg.Pool({ connectionString: url, max: 3 });
  holder = new pg.Client({ connectionString: url });
  await holder.connect();
});
afterAll(async () => {
  await holder.end();
  await pool.end();
});

describe.each(backends)('Storage: $name', (backend) => {
  let storage: Storage;
  let close: () => Promise<void>;
  beforeEach(async () => {
    ({ storage, close } = await backend.open());
  });
  afterEach(() => close());

  it('пишет и читает двоичные данные; повторная запись заменяет содержимое', async () => {
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    await storage.write('templates/t1/v1.docx', bytes);
    expect((await storage.read('templates/t1/v1.docx')).equals(bytes)).toBe(true);
    await storage.write('templates/t1/v1.docx', Buffer.from('второй'));
    expect((await storage.read('templates/t1/v1.docx')).toString()).toBe('второй');
  });

  it('отсутствующий ключ: read — ошибка с code ENOENT, exists — false', async () => {
    await expect(storage.read('reports/none/out.pdf')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await storage.exists('reports/none/out.pdf')).toBe(false);
  });

  it('exists — только для файла (объекта), префикс — false', async () => {
    await storage.write('reports/r1/out.pdf', Buffer.from('1'));
    expect(await storage.exists('reports/r1/out.pdf')).toBe(true);
    expect(await storage.exists('reports/r1')).toBe(false);
  });

  it('remove: ключ-каталог — удаляется всё под key/, соседи с тем же началом целы', async () => {
    for (const k of ['reports/r1/data.json', 'reports/r1/template.docx', 'reports/r1/sub/out.pdf'])
      await storage.write(k, Buffer.from(k));
    for (const k of ['reports/r10/data.json', 'reports/r1x.pdf'])
      await storage.write(k, Buffer.from(k));
    await storage.remove('reports/r1');
    for (const k of ['reports/r1/data.json', 'reports/r1/template.docx', 'reports/r1/sub/out.pdf'])
      expect(await storage.exists(k)).toBe(false);
    expect(await storage.exists('reports/r10/data.json')).toBe(true);
    expect(await storage.exists('reports/r1x.pdf')).toBe(true);
  });

  it('remove: ключ-файл — удаляется сам ключ, соседи с тем же началом целы', async () => {
    await storage.write('reports/r2.pdf', Buffer.from('1'));
    await storage.write('reports/r2.pdf.bak', Buffer.from('2'));
    await storage.remove('reports/r2.pdf');
    expect(await storage.exists('reports/r2.pdf')).toBe(false);
    expect(await storage.exists('reports/r2.pdf.bak')).toBe(true);
  });

  it('remove и removeUngated отсутствующего ключа — не ошибка', async () => {
    await expect(storage.remove('nope/none.bin')).resolves.toBeUndefined();
    await expect(storage.removeUngated('nope/none')).resolves.toBeUndefined();
  });

  it('remove: больше 1000 объектов под префиксом удаляются все', { timeout: 120_000 }, async () => {
    const keys = Array.from(
      { length: 1005 },
      (_, i) => `bulk/run/${String(i).padStart(4, '0')}.bin`,
    );
    await inBatches(keys, (k) => storage.write(k, Buffer.from(k)));
    await storage.write('bulk/run.keep', Buffer.from('сосед'));
    await storage.remove('bulk/run');
    const left = await inBatches(keys, (k) => storage.exists(k));
    expect(left.filter(Boolean)).toHaveLength(0);
    expect(await storage.exists('bulk/run.keep')).toBe(true);
  });

  it.each(INVALID_KEYS)(
    'недопустимый ключ %j: все методы отклоняют, шлюз не вызывается',
    async (key) => {
      const calls: string[] = [];
      const gated = await backend.open(async (fn) => {
        calls.push('gate');
        return fn();
      });
      try {
        const ops = [
          () => gated.storage.read(key),
          () => gated.storage.write(key, Buffer.from('x')),
          () => gated.storage.exists(key),
          () => gated.storage.remove(key),
          () => gated.storage.removeUngated(key),
        ];
        for (const op of ops) await expect(op()).rejects.toThrow(`недопустимый путь: ${key}`);
        expect(calls).toEqual([]);
      } finally {
        await gated.close();
      }
    },
  );

  it('через шлюз идёт только remove', async () => {
    const calls: string[] = [];
    const gated = await backend.open(async (fn) => {
      calls.push('gate');
      return fn();
    });
    try {
      await gated.storage.write('a/x.txt', Buffer.from('1'));
      await gated.storage.read('a/x.txt');
      await gated.storage.exists('a/x.txt');
      await gated.storage.write('a/y.txt', Buffer.from('2'));
      await gated.storage.removeUngated('a/y.txt');
      expect(calls).toEqual([]);
      await gated.storage.remove('a/x.txt');
      expect(calls).toEqual(['gate']);
      expect(await gated.storage.exists('a/x.txt')).toBe(false);
    } finally {
      await gated.close();
    }
  });

  it('remove ждёт исключительную блокировку бэкапа; removeUngated, write и read — нет', async () => {
    const gated = await backend.open(createRemoveGate(pool));
    try {
      await gated.storage.write('gate/a.bin', Buffer.from('a'));
      await gated.storage.write('gate/b.bin', Buffer.from('b'));
      await holder.query('select pg_advisory_lock($1)', [STORAGE_REMOVE_LOCK_KEY]);
      let removed = false;
      const pending = gated.storage.remove('gate/a.bin').then(() => {
        removed = true;
      });
      try {
        await gated.storage.removeUngated('gate/b.bin');
        expect(await gated.storage.exists('gate/b.bin')).toBe(false);
        await gated.storage.write('gate/c.bin', Buffer.from('c'));
        expect((await gated.storage.read('gate/c.bin')).toString()).toBe('c');
        await new Promise((r) => setTimeout(r, 300));
        expect(removed).toBe(false);
        expect(await gated.storage.exists('gate/a.bin')).toBe(true);
      } finally {
        await holder.query('select pg_advisory_unlock($1)', [STORAGE_REMOVE_LOCK_KEY]);
      }
      await pending;
      expect(await gated.storage.exists('gate/a.bin')).toBe(false);
    } finally {
      await gated.close();
    }
  });
});
