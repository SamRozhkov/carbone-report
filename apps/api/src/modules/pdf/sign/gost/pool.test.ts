// Задачи пула gost-prepare и gost-verify настоящим потоком (worker.ts через worker-dev.mjs) и в этом
// потоке: штамп и хеш Стрибог, проверка CAdES, отказ — GOST_INVALID, срок — TIMEOUT (§42).
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../../../../lib/errors';
import { RenderPool, TemplateRenderError } from '../../../render/pool';
import { renderWorkerUrl } from '../../../render/worker-url';
import { makePdf } from '../../test-pdf';
import { prepareStampPdf, type StampLines } from '../prepare';
import type { CadesInput } from './cades';
import {
  createPoolGostPreparer,
  createPoolGostVerifier,
  inProcessGostPreparer,
  inProcessGostVerifier,
} from './pool';
import { streebog } from './streebog';

const fx = (n: string) =>
  new Uint8Array(readFileSync(new URL(`../../../../../test/fixtures/gost/${n}`, import.meta.url)));
const pemDer = (n: string) =>
  new Uint8Array(
    Buffer.from(
      Buffer.from(fx(n))
        .toString()
        .replace(/-----[^-]+-----/g, '')
        .replace(/\s/g, ''),
      'base64',
    ),
  );
const NOW = new Date('2026-10-20T16:00:00Z');
const lines: StampLines = [
  'ДОКУМЕНТ ПОДПИСАН ЭЛЕКТРОННОЙ ПОДПИСЬЮ',
  'Сертификат: 1001',
  'Владелец: Иванов Иван Иванович',
  'Действителен: с 01.01.2026 по 01.01.2046',
  'Подписан: 20.10.2026 19:00',
];
const input = (sig: string, over: Partial<CadesInput> = {}): CadesInput => ({
  signature: fx(sig),
  certDer: pemDer('user256a.pem'),
  hash: streebog(256, fx('doc.pdf')),
  hashAlg: 'streebog256',
  requireTimestamp: false,
  now: NOW,
  ...over,
});

let pool: RenderPool;
beforeAll(() => {
  const w = renderWorkerUrl();
  pool = new RenderPool({ size: 1, workerUrl: w.url, execArgv: w.execArgv });
});
afterAll(() => pool?.destroy());

const soon = () => Date.now() + 20_000;

describe.each([
  ['пул', () => ({ prepare: createPoolGostPreparer(pool), verify: createPoolGostVerifier(pool) })],
  ['этот поток', () => ({ prepare: inProcessGostPreparer, verify: inProcessGostVerifier })],
])('ГОСТ: %s', (_name, deps) => {
  it.each([
    ['streebog256', 256],
    ['streebog512', 512],
  ] as const)(
    'gost-prepare %s: PDF как prepareStampPdf, hash — Стрибог от него',
    async (hashAlg, bits) => {
      const src = Buffer.from(await makePdf([{ label: 'a' }, { label: 'b' }]));
      const r = await deps().prepare(src, { position: 'bottom-right', lines, hashAlg }, soon());
      const ref = await prepareStampPdf(src, { position: 'bottom-right', lines });
      expect(Buffer.isBuffer(r.pdf)).toBe(true);
      expect(r.pdf.equals(Buffer.from(ref))).toBe(true);
      expect(Buffer.from(r.hash).toString('hex')).toBe(
        Buffer.from(streebog(bits, r.pdf)).toString('hex'),
      );
    },
    30_000,
  );

  it('gost-verify: CAdES-BES — без метки', async () => {
    await expect(deps().verify(input('bes-256a.sig'), soon())).resolves.toEqual({
      signedAt: null,
      timestamped: false,
    });
  }, 30_000);

  it('gost-verify: CAdES-T — время метки как Date', async () => {
    await expect(
      deps().verify(input('t-256a.sig', { requireTimestamp: true }), soon()),
    ).resolves.toEqual({ signedAt: new Date('2026-10-20T15:04:15Z'), timestamped: true });
  }, 30_000);

  it('gost-verify: испорченная подпись — GOST_INVALID 400 «подпись недействительна»', async () => {
    const e = await deps()
      .verify(input('bad-value.sig'), soon())
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(AppError);
    expect(e).toMatchObject({
      code: 'GOST_INVALID',
      status: 400,
      message: 'подпись недействительна',
    });
  }, 30_000);
});

describe('пул: срок истёк в очереди — TIMEOUT 504', () => {
  it('gost-prepare', async () => {
    const e = await createPoolGostPreparer(pool)(
      Buffer.from(fx('doc.pdf')),
      { position: 'bottom-right', lines, hashAlg: 'streebog256' },
      Date.now() - 1,
    ).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'TIMEOUT', status: 504, message: 'превышено время ожидания' });
  });

  it('gost-verify', async () => {
    const e = await createPoolGostVerifier(pool)(input('bes-256a.sig'), Date.now() - 1).catch(
      (x: unknown) => x,
    );
    expect(e).toMatchObject({ code: 'TIMEOUT', status: 504, message: 'превышено время ожидания' });
  });
});

describe('пул: прочие ошибки — внутренние', () => {
  const failing = {
    run: async () => {
      throw new TemplateRenderError('сломалось');
    },
  };
  const job = { position: 'bottom-right', lines, hashAlg: 'streebog256' } as const;

  it('ошибка потока без поля gost — не AppError', async () => {
    const p = await createPoolGostPreparer(failing)(Buffer.alloc(1), job, soon()).catch(
      (x: unknown) => x,
    );
    const v = await createPoolGostVerifier(failing)(input('bes-256a.sig'), soon()).catch(
      (x: unknown) => x,
    );
    for (const e of [p, v]) {
      expect(e).toBeInstanceOf(Error);
      expect(e).not.toBeInstanceOf(AppError);
    }
  });

  it('битый PDF в пуле — не AppError', async () => {
    const e = await createPoolGostPreparer(pool)(Buffer.from('не PDF'), job, soon()).catch(
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(AppError);
  }, 30_000);

  const stub = (meta: unknown) => ({ run: async () => ({ out: Buffer.alloc(1), meta }) as never });

  it.each([
    ['meta не объект', null],
    ['hash не hex', { hash: 'zz' }],
    ['hash не той длины', { hash: 'ab'.repeat(64) }],
  ])('gost-prepare, %s — «некорректный ответ потока»', async (_n, meta) => {
    const e = await createPoolGostPreparer(stub(meta))(Buffer.alloc(1), job, soon()).catch(
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(TypeError);
    expect((e as Error).message).toBe('некорректный ответ потока при подготовке PDF ГОСТ');
  });

  it.each([
    ['meta не объект', null],
    ['signedAt не ISO', { signedAt: 'вчера', timestamped: true }],
    ['без timestamped', { signedAt: null }],
  ])('gost-verify, %s — «некорректный ответ потока»', async (_n, meta) => {
    const e = await createPoolGostVerifier(stub(meta))(input('bes-256a.sig'), soon()).catch(
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(TypeError);
    expect((e as Error).message).toBe('некорректный ответ потока при проверке подписи ГОСТ');
  });
});
