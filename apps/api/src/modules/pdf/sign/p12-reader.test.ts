// Разбор .p12 настоящим потоком пула (worker.ts через worker-dev.mjs): ключ из потока подписывает,
// ошибки приходят P12Error с полем, срок истекает в очереди (§39.8).
import { createHash, generateKeyPairSync, sign, verify, X509Certificate } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RenderPool } from '../../render/pool';
import { renderWorkerUrl } from '../../render/worker-url';
import { fixture, FIXTURE_PASSWORD } from './fixtures';
import { P12Error, readP12 } from './p12';
import { createPoolP12Reader, inProcessP12Reader } from './p12-reader';

let pool: RenderPool;
beforeAll(() => {
  const w = renderWorkerUrl();
  pool = new RenderPool({ size: 1, workerUrl: w.url, execArgv: w.execArgv });
});
afterAll(() => pool?.destroy());

const soon = () => Date.now() + 20_000;

describe.each([
  ['пул', () => createPoolP12Reader(pool)],
  ['этот поток', () => inProcessP12Reader],
])('P12Reader: %s', (_name, reader) => {
  it('RSA: ключ подписывает, сведения и цепочка как у readP12', async () => {
    const file = fixture('rsa.p12');
    const now = new Date();
    const got = await reader()(file, FIXTURE_PASSWORD, now, soon());
    const ref = readP12(file, FIXTURE_PASSWORD, now);
    expect(got.info).toEqual(ref.info);
    expect(got.digestAlg).toBe(ref.digestAlg);
    expect(got.cert.equals(ref.cert)).toBe(true);
    expect(got.chain.map((c) => c.toString('hex'))).toEqual(
      ref.chain.map((c) => c.toString('hex')),
    );
    const data = createHash('sha256').update('x').digest();
    const sig = sign('sha256', data, got.key);
    const pub = new X509Certificate(got.cert).publicKey;
    expect(verify('sha256', data, pub, sig)).toBe(true);
  }, 30_000);

  it('ECDSA P-384: digestAlg SHA-384', async () => {
    const got = await reader()(fixture('ec384.p12'), FIXTURE_PASSWORD, new Date(), soon());
    expect(got.digestAlg).toBe('SHA-384');
  }, 30_000);

  it('неверный пароль — P12Error у password; без пароля в тексте', async () => {
    const e = await reader()(fixture('rsa.p12'), 'секрет-123', new Date(), soon()).catch((x) => x);
    expect(e).toBeInstanceOf(P12Error);
    expect(e).toMatchObject({
      field: 'password',
      message: 'неверный пароль или повреждённый файл',
    });
    expect(String(e.message)).not.toContain('секрет-123');
  }, 30_000);

  it('не PKCS#12 — P12Error, как у readP12', async () => {
    const e = await reader()(Buffer.from('not a p12'), FIXTURE_PASSWORD, new Date(), soon()).catch(
      (x) => x,
    );
    expect(e).toBeInstanceOf(P12Error);
    expect(e).toMatchObject({
      field: 'password',
      message: 'неверный пароль или повреждённый файл',
    });
  }, 30_000);

  it('просроченный сертификат — P12Error у file', async () => {
    // Срок проверяется на переданный момент: 2200 год — сертификат (до 2126) уже истёк.
    const e = await reader()(
      fixture('rsa.p12'),
      FIXTURE_PASSWORD,
      new Date('2200-01-01'),
      soon(),
    ).catch((x) => x);
    expect(e).toBeInstanceOf(P12Error);
    expect(e).toMatchObject({ field: 'file', message: 'срок действия сертификата истёк' });
  }, 30_000);
});

it('пул: срок истёк — TIMEOUT 504', async () => {
  const e = await createPoolP12Reader(pool)(
    fixture('rsa.p12'),
    FIXTURE_PASSWORD,
    new Date(),
    Date.now() - 1,
  ).catch((x) => x);
  expect(e).toMatchObject({ code: 'TIMEOUT', status: 504 });
});

it('пул: ошибка потока без поля — не P12Error', async () => {
  const failing = createPoolP12Reader({
    run: async () => {
      const { TemplateRenderError } = await import('../../render/pool');
      throw new TemplateRenderError('сломалось');
    },
  });
  const e = await failing(Buffer.alloc(1), 'x', new Date(), soon()).catch((x) => x);
  expect(e).toBeInstanceOf(Error);
  expect(e).not.toBeInstanceOf(P12Error);
});

describe('пул: некорректный meta потока', () => {
  const stub = (meta: unknown, out: Buffer) =>
    createPoolP12Reader({ run: async () => ({ out, meta }) as never });
  const good = {
    cert: 'AA==',
    chain: [],
    info: {
      subjectCn: 'x',
      issuer: 'y',
      serial: '1',
      notBefore: '2026-01-01T00:00:00.000Z',
      notAfter: '2036-01-01T00:00:00.000Z',
      fingerprint: 'AB',
      keyAlg: 'RSA-2048',
    },
    digestAlg: 'SHA-256',
  };

  it.each([
    ['без chain', { cert: good.cert, info: good.info, digestAlg: good.digestAlg }],
    ['digestAlg md5', { ...good, digestAlg: 'md5' }],
    ['info не объект', { ...good, info: null }],
    ['meta не объект', null],
  ])('%s — обычная ошибка, не TypeError; поток затёрт нулями', async (_n, meta) => {
    // Валидный PKCS#8: отказ должен быть именно из-за meta, а не из-за ключа.
    const out = generateKeyPairSync('ed25519').privateKey.export({ format: 'der', type: 'pkcs8' });
    expect(out.some((b) => b !== 0)).toBe(true);
    const e = await stub(meta, out)(Buffer.alloc(1), 'x', new Date(), soon()).catch((x) => x);
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(TypeError);
    expect(e).not.toBeInstanceOf(P12Error);
    expect(e.message).toBe('некорректный ответ потока при разборе .p12');
    expect(out.every((b) => b === 0)).toBe(true);
  });
});
