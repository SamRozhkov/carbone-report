import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BACKUP_NAME_RE,
  backupName,
  listBackups,
  rotatePreRestore,
  selectPreRestoreToDelete,
} from './backups';

const h = (c: string) => c.repeat(64);
const manifest = (db: number, st: number, mig = h('a')) =>
  [
    'created_utc=x',
    `last_migration=${mig}`,
    `db.dump size=${db} sha256=${h('b')}`,
    `storage.tar.gz size=${st} sha256=${h('c')}`,
  ].join('\n');

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'backups-'));
});
afterEach(() => rm(root, { recursive: true, force: true }));

async function dir(name: string, files: Record<string, string> = {}) {
  await mkdir(join(root, name));
  for (const [f, content] of Object.entries(files)) await writeFile(join(root, name, f), content);
}

describe('listBackups', () => {
  it('каталоги бэкапов новыми сверху; .partial и каталог без manifest — partial; прочее не попадает', async () => {
    await dir('2026-10-08T03-00-00Z', { 'manifest.txt': manifest(100, 200) });
    await dir('pre-restore-2026-10-08T04-00-00Z', { 'manifest.txt': manifest(1, 2) });
    await dir('2026-10-08T05-00-00Z.partial', { 'db.dump': '0123456789' });
    await dir('2026-10-07T03-00-00Z', { 'db.dump': 'x' });
    await dir('.op');
    await dir('notes');
    await writeFile(join(root, '2026-10-06T03-00-00Z'), 'файл, не каталог');
    expect(await listBackups(root)).toEqual([
      {
        name: '2026-10-08T05-00-00Z.partial',
        createdAt: '2026-10-08T05:00:00Z',
        dbSize: 10,
        storageSize: null,
        lastMigration: null,
        kind: 'regular',
        status: 'partial',
      },
      {
        name: 'pre-restore-2026-10-08T04-00-00Z',
        createdAt: '2026-10-08T04:00:00Z',
        dbSize: 1,
        storageSize: 2,
        lastMigration: h('a'),
        kind: 'pre-restore',
        status: 'ok',
      },
      {
        name: '2026-10-08T03-00-00Z',
        createdAt: '2026-10-08T03:00:00Z',
        dbSize: 100,
        storageSize: 200,
        lastMigration: h('a'),
        kind: 'regular',
        status: 'ok',
      },
      {
        name: '2026-10-07T03-00-00Z',
        createdAt: '2026-10-07T03:00:00Z',
        dbSize: 1,
        storageSize: null,
        lastMigration: null,
        kind: 'regular',
        status: 'partial',
      },
    ]);
  });
  it('каталог, исчезнувший между readdir и stat (ротация), пропускается', async () => {
    await dir('2026-10-08T03-00-00Z', { 'manifest.txt': manifest(100, 200) });
    await dir('2026-10-07T03-00-00Z', { 'manifest.txt': manifest(1, 2) });
    const real = await import('node:fs/promises');
    const gone = join(root, '2026-10-07T03-00-00Z');
    vi.resetModules();
    vi.doMock('node:fs/promises', () => ({
      ...real,
      stat: async (p: string, ...rest: unknown[]) => {
        if (p === gone) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return (real.stat as (...a: unknown[]) => Promise<unknown>)(p, ...rest);
      },
    }));
    try {
      const { listBackups: list } = await import('./backups');
      expect((await list(root)).map((b) => b.name)).toEqual(['2026-10-08T03-00-00Z']);
    } finally {
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    }
  });
  it('нет каталога — пустой список', async () => {
    expect(await listBackups(join(root, 'нет'))).toEqual([]);
  });
});

describe('имена', () => {
  it('backupName — как date -u +%Y-%m-%dT%H-%M-%SZ в backup.sh', () => {
    const at = new Date('2026-10-08T03:04:05.678Z');
    expect(backupName(at)).toBe('2026-10-08T03-04-05Z');
    expect(backupName(at, 'pre-restore-')).toBe('pre-restore-2026-10-08T03-04-05Z');
  });
  it('BACKUP_NAME_RE — шаблон из §26.1', () => {
    expect(BACKUP_NAME_RE.test('2026-10-08T03-04-05Z')).toBe(true);
    expect(BACKUP_NAME_RE.test('pre-restore-2026-10-08T03-04-05Z')).toBe(true);
    for (const bad of [
      '2026-10-08T03-04-05Z.partial',
      '../2026-10-08T03-04-05Z',
      'pre-restore-',
      '.op',
    ])
      expect(BACKUP_NAME_RE.test(bad)).toBe(false);
  });
});

describe('ротация pre-restore', () => {
  const pre = (d: number) => `pre-restore-2026-10-0${d}T00-00-00Z`;
  it('из pre-restore остаются 3 новых; обычные и .partial не учитываются', () => {
    const names = [
      pre(1),
      pre(2),
      pre(3),
      pre(4),
      pre(5),
      '2026-10-01T00-00-00Z',
      `${pre(9)}.partial`,
    ];
    expect(selectPreRestoreToDelete(names)).toEqual([pre(2), pre(1)]);
  });
  it('защищённое имя (восстанавливаемый бэкап) не удаляется, остальные — как обычно', () => {
    const names = [pre(1), pre(2), pre(3), pre(4), pre(5)];
    expect(selectPreRestoreToDelete(names, 3, pre(1))).toEqual([pre(2)]);
    expect(selectPreRestoreToDelete(names, 3, pre(4))).toEqual([pre(2), pre(1)]);
  });
  it('rotatePreRestore с защищённым именем оставляет его на диске', async () => {
    for (const d of [1, 2, 3, 4]) await dir(pre(d));
    expect(await rotatePreRestore(root, 3, pre(1))).toEqual([]);
    expect((await readdir(root)).sort()).toEqual([pre(1), pre(2), pre(3), pre(4)]);
  });
  it('rotatePreRestore удаляет каталоги на диске и не трогает обычные бэкапы', async () => {
    for (const d of [1, 2, 3, 4]) await dir(pre(d));
    await dir('2026-10-01T00-00-00Z');
    await dir(`${pre(9)}.partial`);
    expect(await rotatePreRestore(root)).toEqual([pre(1)]);
    expect((await readdir(root)).sort()).toEqual(
      ['2026-10-01T00-00-00Z', pre(2), pre(3), pre(4), `${pre(9)}.partial`].sort(),
    );
  });
});
