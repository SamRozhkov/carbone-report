import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

/** Обёртка вокруг удаления: бэкап приостанавливает удаления, чтобы дамп и архив совпадали. */
export type RemoveGate = (<T>(fn: () => Promise<T>) => Promise<T>) & {
  /** Не ждёт: если бэкап идёт, fn не вызывается и возвращается false. */
  tryRun?: (fn: () => Promise<void>) => Promise<boolean>;
};
const passThrough: RemoveGate = (fn) => fn();

export class Storage {
  private readonly root: string;

  constructor(
    root: string,
    private readonly removeGate: RemoveGate = passThrough,
  ) {
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

  /** Удаляет файл или каталог целиком; отсутствие — не ошибка. Ждёт, пока идёт бэкап. */
  async remove(rel: string): Promise<void> {
    const abs = this.path(rel);
    await this.removeGate(() => rm(abs, { recursive: true, force: true }));
  }

  /** Удаляет, только если бэкап не идёт; иначе ничего не делает и возвращает false. */
  async removeIfIdle(rel: string): Promise<boolean> {
    const abs = this.path(rel);
    const run = () => rm(abs, { recursive: true, force: true });
    if (!this.removeGate.tryRun) {
      await this.removeGate(run);
      return true;
    }
    return this.removeGate.tryRun(run);
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
