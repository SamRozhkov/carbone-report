import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

export class Storage {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  path(rel: string): string {
    const abs = resolve(this.root, rel);
    if (!abs.startsWith(this.root + sep)) throw new Error(`недопустимый путь: ${rel}`);
    return abs;
  }

  async write(rel: string, data: Buffer): Promise<void> {
    const abs = this.path(rel);
    await mkdir(dirname(abs), { recursive: true });
    const tmp = `${abs}.${randomUUID()}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, abs);
  }

  read(rel: string): Promise<Buffer> {
    return readFile(this.path(rel));
  }

  async remove(rel: string): Promise<void> {
    await rm(this.path(rel), { force: true });
  }

  async exists(rel: string): Promise<boolean> {
    try {
      await access(this.path(rel));
      return true;
    } catch {
      return false;
    }
  }
}
