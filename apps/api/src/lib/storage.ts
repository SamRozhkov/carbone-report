import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';

/** Обёртка вокруг удаления: бэкап приостанавливает удаления, чтобы дамп и архив совпадали. */
export type RemoveGate = <T>(fn: () => Promise<T>) => Promise<T>;
export const passThrough: RemoveGate = (fn) => fn();

/**
 * Файлы приложения. Ключ — относительный путь вида `templates/<id>/v3.docx` (см. `checkKey`).
 * Реализации: `LocalStorage` (каталог на диске) и `S3Storage` (бакет S3, `lib/s3-storage.ts`).
 */
export interface Storage {
  /** Файл целиком; нет файла — ошибка с `code = 'ENOENT'`. */
  read(key: string): Promise<Buffer>;
  /** Атомарная запись: читатель видит прежнее или новое содержимое целиком. */
  write(key: string, data: Buffer): Promise<void>;
  /** Удаляет `key` и всё под `key/`; отсутствие — не ошибка. Ждёт, пока идёт бэкап. */
  remove(key: string): Promise<void>;
  /** Как `remove`, но без шлюза: вызывающий уже держит разделяемую блокировку бэкапа. */
  removeUngated(key: string): Promise<void>;
  /** Есть ли файл (объект) с этим ключом; «каталог» (префикс) — false. */
  exists(key: string): Promise<boolean>;
  /** Освобождает ресурсы (соединения S3) при остановке; после вызова хранилище не используется. */
  close?(): Promise<void>;
}

/**
 * Допустимый ключ: непустые сегменты через «/», без «.», «..» и «\». Пустой ключ, ведущий и
 * завершающий «/» и «//» дают пустой сегмент. Ошибка — та же, что раньше у выхода за корень.
 */
export function checkKey(key: string): string {
  const bad =
    key === '' ||
    key.includes('\\') ||
    key.split('/').some((s) => s === '' || s === '.' || s === '..');
  if (bad) throw new Error(`недопустимый путь: ${key}`);
  return key;
}

export class LocalStorage implements Storage {
  private readonly root: string;

  constructor(
    root: string,
    private readonly removeGate: RemoveGate = passThrough,
  ) {
    this.root = resolve(root);
  }

  private abs(key: string): string {
    const abs = resolve(this.root, checkKey(key));
    // checkKey уже не пускает за корень; проверка пути остаётся второй линией защиты.
    if (!abs.startsWith(this.root + sep)) throw new Error(`недопустимый путь: ${key}`);
    return abs;
  }

  async write(key: string, data: Buffer): Promise<void> {
    const abs = this.abs(key);
    await mkdir(dirname(abs), { recursive: true });
    const tmp = `${abs}.${randomUUID()}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, abs);
  }

  async read(key: string): Promise<Buffer> {
    const abs = this.abs(key);
    try {
      return await readFile(abs);
    } catch (e) {
      // Часть пути — файл (a/b при файле a): ключа нет, как NoSuchKey у S3Storage.
      if ((e as NodeJS.ErrnoException).code === 'ENOTDIR')
        throw Object.assign(new Error(`ENOENT: нет файла ${key}`, { cause: e }), {
          code: 'ENOENT',
        });
      throw e;
    }
  }

  async remove(key: string): Promise<void> {
    const abs = this.abs(key);
    await this.removeGate(() => rm(abs, { recursive: true, force: true }));
  }

  async removeUngated(key: string): Promise<void> {
    await rm(this.abs(key), { recursive: true, force: true });
  }

  async exists(key: string): Promise<boolean> {
    const abs = this.abs(key);
    try {
      return (await stat(abs)).isFile();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return false;
      throw e;
    }
  }

  /** Каталог на диске: закрывать нечего. */
  async close(): Promise<void> {}
}
