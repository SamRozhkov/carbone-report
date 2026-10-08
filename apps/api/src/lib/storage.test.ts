import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkKey, LocalStorage } from './storage';

let root: string;
let storage: LocalStorage;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'storage-'));
  storage = new LocalStorage(root);
});
afterEach(() => rm(root, { recursive: true, force: true }));

describe('checkKey', () => {
  it.each([
    'templates/t1/v3.docx',
    'reports/r1/out.pdf',
    'a',
    'a.b/c..d',
    'templates/t1/orphan.tmp',
  ])('допускает %j', (key) => {
    expect(checkKey(key)).toBe(key);
  });
  it.each(['', '/etc/passwd', '..', '.', '../x', 'a/..', 'a/./b', 'a\\b', 'a//b', 'a/'])(
    'отклоняет %j той же ошибкой, что выход за корень',
    (key) => {
      expect(() => checkKey(key)).toThrow(`недопустимый путь: ${key}`);
    },
  );
});

describe('LocalStorage', () => {
  it('пишет и читает, создавая каталоги', async () => {
    await storage.write('templates/a.docx', Buffer.from('hello'));
    expect((await storage.read('templates/a.docx')).toString()).toBe('hello');
    expect(await storage.exists('templates/a.docx')).toBe(true);
  });
  it('не оставляет временных файлов', async () => {
    await storage.write('reports/x.pdf', Buffer.from('1'));
    expect(await readdir(join(root, 'reports'))).toEqual(['x.pdf']);
  });
  it('remove удаляет каталог целиком, а не только файлы в нём', async () => {
    await storage.write('templates/t1/v1.docx', Buffer.from('1'));
    await storage.write('templates/t1/v2.docx', Buffer.from('2'));
    await storage.remove('templates/t1');
    expect(await readdir(join(root, 'templates'))).toEqual([]);
  });
  it('exists: файл — true, каталог — false (как префикс на S3)', async () => {
    await storage.write('reports/r1/out.pdf', Buffer.from('1'));
    expect(await storage.exists('reports/r1/out.pdf')).toBe(true);
    expect(await storage.exists('reports/r1')).toBe(false);
    expect(await storage.exists('reports/r1/out.pdf/x')).toBe(false);
  });
  it('read ключа под файлом (ENOTDIR) — ошибка с code ENOENT, как NoSuchKey на S3', async () => {
    await storage.write('a', Buffer.from('файл'));
    await expect(storage.read('a/b')).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('запрещает выход за корень во всех методах', async () => {
    const ops = [
      () => storage.read('../etc/passwd'),
      () => storage.write('../x', Buffer.from('1')),
      () => storage.exists('../x'),
      () => storage.remove('../x'),
      () => storage.removeUngated('../x'),
    ];
    for (const op of ops) await expect(op()).rejects.toThrow(/недопустимый путь/);
  });
});
