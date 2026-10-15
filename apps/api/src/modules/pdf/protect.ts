import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PdfProtector } from '../../deps';
import { AppError } from '../../lib/errors';

/** Защита итогового PDF (§37.2). `userPassword: ''` — документ открывается без пароля. */
export interface PdfProtectJob {
  userPassword: string;
  noPrint: boolean;
  noCopy: boolean;
  noModify: boolean;
}

const unavailable = () =>
  new AppError('PDF_PROTECT_UNAVAILABLE', 503, 'шифрование PDF недоступно: не установлен qpdf');
const timeout = () => new AppError('TIMEOUT', 504, 'превышено время ожидания');

/** Аргументы qpdf 11.3 (позиционный `--encrypt`, AES-256); пишутся по одному на строку в файл @args. */
export function qpdfArgs(
  job: PdfProtectJob,
  owner: string,
  input: string,
  output: string,
): string[] {
  return [
    input,
    '--encrypt',
    job.userPassword,
    owner,
    '256',
    ...(job.noPrint ? ['--print=none'] : []),
    ...(job.noCopy ? ['--extract=n'] : []),
    ...(job.noModify ? ['--modify=none'] : []),
    '--',
    output,
  ];
}

/** Не больше `max` задач одновременно; освободившееся место передаётся следующему в очереди. */
export function limiter(max: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active < max) active++;
    else await new Promise<void>((resolve) => queue.push(resolve));
    try {
      return await fn();
    } finally {
      const next = queue.shift();
      if (next) next();
      else active--;
    }
  };
}

function runQpdf(bin: string, argsFile: string, timeoutMs: number): Promise<void> {
  if (timeoutMs <= 0) return Promise.reject(timeout());
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      [`@${argsFile}`],
      { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 },
      (err, _stdout, stderr) => {
        if (!err) return resolve();
        const e = err as Error & { code?: string | number; killed?: boolean };
        if (e.code === 'ENOENT') return reject(unavailable());
        if (e.killed) return reject(timeout());
        // 3 — готово с предупреждениями: файл записан.
        if (e.code === 3) return resolve();
        // В stderr qpdf — пути и описание ошибки, без аргументов из файла @args.
        const cause = new Error(`qpdf: код ${String(e.code)}: ${String(stderr).slice(0, 2000)}`);
        reject(new AppError('PDF_ERROR', 502, 'не удалось зашифровать PDF', undefined, cause));
      },
    );
  });
}

/**
 * Шифрование готового PDF программой qpdf (§37.2). Пароли — только в файле аргументов во временном
 * каталоге (0700, файлы 0600); каталог удаляется при любом исходе. Пароль владельца — случайный.
 */
export function createQpdfProtector(opts: {
  bin?: string;
  maxConcurrent: number;
  tmpRoot?: string;
}): PdfProtector {
  const bin = opts.bin ?? 'qpdf';
  const limit = limiter(opts.maxConcurrent);
  return (pdf, job, timeoutMs) =>
    limit(async () => {
      const started = Date.now();
      const dir = await mkdtemp(join(opts.tmpRoot ?? tmpdir(), 'cr-qpdf-'));
      try {
        const input = join(dir, 'in.pdf');
        const output = join(dir, 'out.pdf');
        const argsFile = join(dir, 'args');
        await writeFile(input, pdf, { mode: 0o600 });
        const owner = randomBytes(32).toString('base64url');
        await writeFile(argsFile, `${qpdfArgs(job, owner, input, output).join('\n')}\n`, {
          mode: 0o600,
        });
        await runQpdf(bin, argsFile, timeoutMs - (Date.now() - started));
        return await readFile(output);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
}

/** Версия qpdf или null, если программы нет: проверка при старте API (R8). */
export function qpdfVersion(bin = 'qpdf'): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(bin, ['--version'], { timeout: 5000 }, (err, stdout) =>
      resolve(err ? null : (String(stdout).split('\n')[0] ?? '').trim()),
    );
  });
}
