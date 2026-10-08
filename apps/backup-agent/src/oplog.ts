import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
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
export function fileOpLogs(dir: string, keep = 20, tailLines = 500): OpLogs {
  return {
    async open(id) {
      await mkdir(dir, { recursive: true });
      const stream = createWriteStream(join(dir, `${id}.log`), { flags: 'a' });
      await once(stream, 'open');
      await prune(dir, keep);
      return {
        write: (line) => void stream.write(`${line}\n`),
        close: () => new Promise<void>((resolve) => stream.end(resolve)),
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
