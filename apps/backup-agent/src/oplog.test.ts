import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileOpLogs } from './oplog';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'oplog-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('fileOpLogs', () => {
  it('пишет строки в <id>.log, tail отдаёт последние 500', async () => {
    const logs = fileOpLogs(dir);
    const log = await logs.open('a1');
    for (let i = 1; i <= 600; i++) log.write(`строка ${i}`);
    await log.close();
    const tail = await logs.tail('a1');
    expect(tail).toHaveLength(500);
    expect(tail[0]).toBe('строка 101');
    expect(tail.at(-1)).toBe('строка 600');
  });

  it('неизвестная операция — пустой журнал', async () => {
    expect(await fileOpLogs(dir).tail('нет')).toEqual([]);
  });

  it('хранятся последние 20 журналов; state.json и прочие файлы не трогаются', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'state.json'), '{}');
    for (let i = 0; i < 22; i++) {
      const f = join(dir, `old${String(i).padStart(2, '0')}.log`);
      await writeFile(f, 'x\n');
      const t = new Date(Date.UTC(2026, 0, 1, 0, i));
      await utimes(f, t, t);
    }
    const log = await fileOpLogs(dir).open('new');
    await log.close();
    const files = (await readdir(dir)).sort();
    expect(files.filter((f) => f.endsWith('.log'))).toHaveLength(20);
    expect(files).toContain('new.log');
    expect(files).toContain('state.json');
    expect(files).not.toContain('old00.log');
    expect(files).not.toContain('old01.log');
    expect(files).not.toContain('old02.log');
  });
});
