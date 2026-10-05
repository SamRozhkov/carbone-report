import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Storage } from './storage';

let root: string;
let storage: Storage;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'storage-'));
  storage = new Storage(root);
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe('Storage', () => {
  it('пишет и читает, создавая каталоги', async () => {
    await storage.write('templates/a.docx', Buffer.from('hello'));
    expect((await storage.read('templates/a.docx')).toString()).toBe('hello');
    expect(await storage.exists('templates/a.docx')).toBe(true);
  });
  it('не оставляет временных файлов', async () => {
    await storage.write('reports/x.pdf', Buffer.from('1'));
    expect(await readdir(join(root, 'reports'))).toEqual(['x.pdf']);
  });
  it('remove игнорирует отсутствующий файл', async () => {
    await expect(storage.remove('nope/none.bin')).resolves.toBeUndefined();
  });
  it('remove идёт через шлюз, write и read — нет', async () => {
    const calls: string[] = [];
    const gated = new Storage(root, async (fn) => {
      calls.push('gate');
      return fn();
    });
    await gated.write('a/x.txt', Buffer.from('1'));
    await gated.read('a/x.txt');
    expect(calls).toEqual([]);
    await gated.remove('a/x.txt');
    expect(calls).toEqual(['gate']);
    expect(await gated.exists('a/x.txt')).toBe(false);
  });
  it('запрещает выход за корень', () => {
    expect(() => storage.path('../etc/passwd')).toThrow(/недопустимый путь/);
  });
});
