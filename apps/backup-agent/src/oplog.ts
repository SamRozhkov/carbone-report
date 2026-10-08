import { once } from 'node:events';
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface OpLog {
  write(line: string): void;
  close(): Promise<void>;
}

export interface OpLogs {
  open(id: string): Promise<OpLog>;
  tail(id: string): Promise<string[]>;
}

/** Журналы операций /backups/.op/<id>.log (§26.1): хранятся последние keep, отдаётся хвост tailLines строк. */
export function fileOpLogs(
  dir: string,
  keep = 20,
  tailLines = 500,
  /** Подмена в тестах: имитация сбоя записи. */
  createStream: (path: string) => WriteStream = (path) => createWriteStream(path, { flags: 'a' }),
): OpLogs {
  return {
    async open(id) {
      await mkdir(dir, { recursive: true });
      const stream = createStream(join(dir, `${id}.log`));
      await once(stream, 'open');
      // Сбой записи после открытия (ENOSPC/EIO) не должен ронять агента посреди восстановления:
      // журнал перестаёт писаться, операция продолжается.
      let broken = false;
      stream.on('error', () => {
        broken = true;
      });
      await prune(dir, keep);
      return {
        write: (line) => {
          if (!broken) stream.write(`${line}\n`);
        },
        close: () =>
          new Promise<void>((resolve) => {
            if (broken || stream.destroyed) return resolve();
            stream.once('error', () => resolve());
            stream.end(resolve);
          }),
      };
    },
    async tail(id) {
      let text: string;
      try {
        text = await readFile(join(dir, `${id}.log`), 'utf8');
      } catch {
        return [];
      }
      const lines = text.split('\n');
      if (lines.at(-1) === '') lines.pop();
      return lines.slice(-tailLines);
    },
  };
}

async function prune(dir: string, keep: number): Promise<void> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.log'));
  const dated = await Promise.all(
    files.map(async (f) => ({ f, t: (await stat(join(dir, f))).mtimeMs })),
  );
  dated.sort((a, b) => b.t - a.t || b.f.localeCompare(a.f));
  for (const { f } of dated.slice(keep)) await rm(join(dir, f), { force: true });
}
