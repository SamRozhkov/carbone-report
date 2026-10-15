import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppError } from '../../lib/errors';
import { makePdf, pageTexts } from './test-pdf';
import { createQpdfProtector, limiter, qpdfArgs, qpdfVersion, type PdfProtectJob } from './protect';

const exec = promisify(execFile);
const version = await qpdfVersion();
const job = (p: Partial<PdfProtectJob> = {}): PdfProtectJob => ({
  userPassword: '',
  noPrint: false,
  noCopy: false,
  noModify: false,
  ...p,
});
const report = async () => Buffer.from(await makePdf([{ label: 'REPORT' }]));

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cr-protect-test-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Подставной qpdf: shell-скрипт с заданным телом. */
async function fakeQpdf(body: string): Promise<string> {
  const bin = join(root, 'fake-qpdf');
  await writeFile(bin, `#!/bin/sh\n${body}\n`);
  await chmod(bin, 0o755);
  return bin;
}

async function showEncryption(pdf: Buffer, password?: string): Promise<string> {
  const f = join(root, 'check.pdf');
  await writeFile(f, pdf);
  const pw = password === undefined ? [] : [`--password=${password}`];
  return (await exec('qpdf', ['--show-encryption', ...pw, f])).stdout;
}

describe('qpdfArgs', () => {
  it('позиционный синтаксис qpdf 11.3, запреты по флажкам', () => {
    expect(
      qpdfArgs(job({ userPassword: 'п 1', noPrint: true, noModify: true }), 'OWN', '/i', '/o'),
    ).toEqual([
      '/i',
      '--encrypt',
      'п 1',
      'OWN',
      '256',
      '--print=none',
      '--modify=none',
      '--',
      '/o',
    ]);
    expect(qpdfArgs(job({ noCopy: true }), 'OWN', '/i', '/o')).toEqual([
      '/i',
      '--encrypt',
      '',
      'OWN',
      '256',
      '--extract=n',
      '--',
      '/o',
    ]);
  });
});

describe('limiter', () => {
  it('одновременно не больше max, все задачи выполняются', async () => {
    const limit = limiter(2);
    let active = 0;
    let peak = 0;
    const task = (i: number) =>
      limit(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return i;
      });
    expect(await Promise.all([1, 2, 3, 4, 5].map(task))).toEqual([1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
  });

  it('ошибка задачи освобождает место', async () => {
    const limit = limiter(1);
    await expect(limit(async () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    expect(await limit(async () => 7)).toBe(7);
  });
});

describe('createQpdfProtector — без настоящего qpdf', () => {
  it('нет программы — 503 «не установлен qpdf», временный каталог убран', async () => {
    const protect = createQpdfProtector({
      bin: join(root, 'nope'),
      maxConcurrent: 1,
      tmpRoot: root,
    });
    const err = await protect(await report(), job({ noPrint: true }), 5000).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({
      code: 'PDF_PROTECT_UNAVAILABLE',
      status: 503,
      message: 'шифрование PDF недоступно: не установлен qpdf',
    });
    expect(await readdir(root)).toEqual([]);
  });

  it('срок истёк — процесс убит, 504, временный каталог убран', async () => {
    const bin = await fakeQpdf('sleep 5');
    const protect = createQpdfProtector({ bin, maxConcurrent: 1, tmpRoot: root });
    const started = Date.now();
    const err = await protect(await report(), job({ noPrint: true }), 200).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: 'TIMEOUT',
      status: 504,
      message: 'превышено время ожидания',
    });
    expect(Date.now() - started).toBeLessThan(3000);
    expect((await readdir(root)).filter((f) => f !== 'fake-qpdf')).toEqual([]);
  });

  it('пароль не попадает в аргументы процесса — только в файл @args', async () => {
    const capture = join(root, 'capture');
    const bin = await fakeQpdf(
      `echo "$@" > '${capture}.argv'\ncp "\${1#@}" '${capture}.args'\nexit 9`,
    );
    const protect = createQpdfProtector({ bin, maxConcurrent: 1, tmpRoot: root });
    const err = await protect(await report(), job({ userPassword: 'секрет-42' }), 5000).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({
      code: 'PDF_ERROR',
      status: 502,
      message: 'не удалось зашифровать PDF',
    });
    const argv = (await readFile(`${capture}.argv`, 'utf8')).trim();
    expect(argv).toMatch(/^@\/.+\/args$/);
    expect(argv).not.toContain('секрет-42');
    const lines = (await readFile(`${capture}.args`, 'utf8')).split('\n');
    expect(lines.slice(1, 5)).toEqual([
      '--encrypt',
      'секрет-42',
      expect.stringMatching(/^[0-9a-f]{64}$/),
      '256',
    ]);
    expect(JSON.stringify(err)).not.toContain('секрет-42');
  });
});

describe('createQpdfProtector — переполнение stderr', () => {
  it('вывод больше maxBuffer — 502, а не 504 TIMEOUT', async () => {
    const bin = await fakeQpdf('head -c 2000000 /dev/zero | tr "\\0" x >&2\nsleep 5');
    const protect = createQpdfProtector({ bin, maxConcurrent: 1, tmpRoot: root });
    const err = await protect(await report(), job(), 10000).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: 'PDF_ERROR', status: 502 });
  });
});

describe('createQpdfProtector — пароли, срок и очередь', () => {
  it('пароль владельца — hex, не начинается с «-»', async () => {
    const bin = await fakeQpdf(`sed -n 4p "\${1#@}" >> '${join(root, 'owners')}'\nexit 9`);
    const protect = createQpdfProtector({ bin, maxConcurrent: 1, tmpRoot: root });
    for (let i = 0; i < 20; i++) await protect(await report(), job(), 5000).catch(() => undefined);
    const owners = (await readFile(join(root, 'owners'), 'utf8')).trim().split('\n');
    expect(owners).toHaveLength(20);
    for (const o of owners) expect(o).toMatch(/^[0-9a-f]{64}$/);
  });

  it('пароли вырезаются из причины ошибки (qpdf повторяет аргументы в stderr)', async () => {
    const bin = await fakeQpdf('cat "${1#@}" >&2\nexit 2');
    const protect = createQpdfProtector({ bin, maxConcurrent: 1, tmpRoot: root });
    const err = (await protect(await report(), job({ userPassword: 'секрет-42' }), 5000).catch(
      (e: unknown) => e,
    )) as AppError;
    expect(err).toMatchObject({ code: 'PDF_ERROR', status: 502 });
    const internal = String((err.internal as Error).message);
    expect(internal).toContain('***');
    expect(internal).not.toContain('секрет-42');
    expect(internal).not.toMatch(/[0-9a-f]{64}/);
  });

  it('ожидание в очереди входит в срок: 504 без запуска qpdf', async () => {
    const bin = await fakeQpdf(
      `echo run >> '${join(root, 'runs')}'\nsleep 0.3\ncp "$(sed -n 1p "\${1#@}")" "$(sed -n 8p "\${1#@}")"`,
    );
    const protect = createQpdfProtector({ bin, maxConcurrent: 1, tmpRoot: root });
    const pdf = await report();
    const first = protect(pdf, job({ noPrint: true }), 5000);
    const second = protect(pdf, job({ noPrint: true }), 100).catch((e: unknown) => e);
    expect(await second).toMatchObject({ code: 'TIMEOUT', status: 504 });
    await first;
    expect((await readFile(join(root, 'runs'), 'utf8')).trim().split('\n')).toHaveLength(1);
  });

  it('limiter: max меньше 1 трактуется как 1', async () => {
    expect(await limiter(0)(async () => 5)).toBe(5);
  });
});

if (process.env.REQUIRE_QPDF === '1') {
  it('REQUIRE_QPDF=1: qpdf установлен', () => {
    expect(version).not.toBeNull();
  });
}

describe.skipIf(version === null)('createQpdfProtector — настоящий qpdf', () => {
  const protect = () => createQpdfProtector({ maxConcurrent: 2, tmpRoot: root });

  it('пароль на открытие: без пароля не открывается, с паролем — текст; AES-256', async () => {
    const out = await protect()(await report(), job({ userPassword: 'секрет1' }), 10000);
    await expect(pageTexts(out)).rejects.toThrow(/password/i);
    expect((await pageTexts(out, 'секрет1'))[0]).toContain('REPORT');
    const info = await showEncryption(out, 'секрет1');
    expect(info).toContain('R = 6');
    expect(info).toContain('file encryption method: AESv3');
    expect(info).toContain('print high resolution: allowed');
    // Без пароля qpdf 11.3 и 12.x выходят с 0 и печатают «Incorrect password supplied»; на всякий случай допускаем и ошибку.
    const noPw = await showEncryption(out).catch(
      (e: { stdout?: string; stderr?: string }) => `${e.stdout ?? ''}${e.stderr ?? ''}`,
    );
    expect(noPw).toMatch(/(incorrect|invalid) password/i);
    expect(await readdir(root)).toEqual(['check.pdf']);
  });

  it('только запреты: открывается без пароля, запреты стоят', async () => {
    const out = await protect()(
      await report(),
      job({ noPrint: true, noCopy: true, noModify: true }),
      10000,
    );
    expect((await pageTexts(out))[0]).toContain('REPORT');
    const info = await showEncryption(out);
    expect(info).toContain('print high resolution: not allowed');
    expect(info).toContain('extract for any purpose: not allowed');
    expect(info).toContain('modify anything: not allowed');
  });

  it('один запрет — остальное разрешено', async () => {
    const info = await showEncryption(
      await protect()(await report(), job({ noPrint: true }), 10000),
    );
    expect(info).toContain('print high resolution: not allowed');
    expect(info).toContain('extract for any purpose: allowed');
    expect(info).toContain('modify anything: allowed');
  });

  it('пароль с пробелами по краям и спецсимволами — ровно этот пароль', async () => {
    for (const pw of [' пароль #1 ', 'x--@\\"y']) {
      const out = await protect()(await report(), job({ userPassword: pw }), 10000);
      expect((await pageTexts(out, pw))[0]).toContain('REPORT');
      if (pw !== pw.trim()) await expect(pageTexts(out, pw.trim())).rejects.toThrow(/password/i);
    }
  });

  it('не PDF — 502, временный каталог убран', async () => {
    const err = await protect()(Buffer.from('not a pdf'), job({ noPrint: true }), 10000).catch(
      (e: unknown) => e,
    );
    expect(err).toMatchObject({ code: 'PDF_ERROR', status: 502 });
    expect(await readdir(root)).toEqual([]);
  });
});
