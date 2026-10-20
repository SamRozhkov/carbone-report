import {
  createCipheriv,
  createHash,
  generateKeyPairSync,
  pbkdf2Sync,
  randomBytes,
} from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fixture, fixtureCertDer, FIXTURE_PASSWORD } from './fixtures';
import forge from 'node-forge';
import {
  hasGostOid,
  MAX_P12_BYTES,
  MAX_P12_ITERATIONS,
  MAX_P12_TOTAL_ITERATIONS,
  P12Error,
  readP12,
} from './p12';

const read = (name: string, password = FIXTURE_PASSWORD, now?: Date) =>
  readP12(fixture(name), password, now);

function fails(fn: () => unknown, field: 'file' | 'password', message: string) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(P12Error);
    expect({ field: (e as P12Error).field, message: (e as P12Error).message }).toEqual({
      field,
      message,
    });
    return;
  }
  throw new Error('ожидалась P12Error');
}

// --- Синтетические .p12: rsa.p12 плюс дополнительные зашифрованные части (PBES2/AES-256-CBC) ---
const A = forge.asn1;
const seq = (...v: forge.asn1.Asn1[]) => A.create(A.Class.UNIVERSAL, A.Type.SEQUENCE, true, v);
const oid = (o: string) => A.create(A.Class.UNIVERSAL, A.Type.OID, false, A.oidToDer(o).getBytes());
const int = (n: number) =>
  A.create(A.Class.UNIVERSAL, A.Type.INTEGER, false, A.integerToDer(n).getBytes());
const oct = (b: Buffer | string) =>
  A.create(
    A.Class.UNIVERSAL,
    A.Type.OCTETSTRING,
    false,
    typeof b === 'string' ? b : b.toString('binary'),
  );
const explicit0 = (v: forge.asn1.Asn1) => A.create(A.Class.CONTEXT_SPECIFIC, 0, true, [v]);
const der = (a: forge.asn1.Asn1) => Buffer.from(A.toDer(a).getBytes(), 'binary');
const O = {
  data: '1.2.840.113549.1.7.1',
  encryptedData: '1.2.840.113549.1.7.6',
  pbes2: '1.2.840.113549.1.5.13',
  pbkdf2: '1.2.840.113549.1.5.12',
  hmacSha256: '1.2.840.113549.2.9',
  aes256: '2.16.840.1.101.3.4.1.42',
  shroudedKeyBag: '1.2.840.113549.1.12.10.1.2',
};

const pbkdf2Cache = new Map<number, { salt: Buffer; key: Buffer }>();

/** AlgorithmIdentifier PBES2 и шифрование `plain` паролем fixture (UTF-8, как OpenSSL 3). */
function pbes2Encrypt(plain: Buffer, iterations: number) {
  // Части расшифровываются по-настоящему (атака реальна); ключ один на число итераций.
  let k = pbkdf2Cache.get(iterations);
  if (!k) {
    const salt = randomBytes(8);
    k = { salt, key: pbkdf2Sync(FIXTURE_PASSWORD, salt, iterations, 32, 'sha256') };
    pbkdf2Cache.set(iterations, k);
  }
  const { salt, key } = k;
  const iv = randomBytes(16);
  const c = createCipheriv('aes-256-cbc', key, iv);
  const alg = seq(
    oid(O.pbes2),
    seq(
      seq(
        oid(O.pbkdf2),
        seq(
          oct(salt),
          int(iterations),
          seq(oid(O.hmacSha256), A.create(A.Class.UNIVERSAL, A.Type.NULL, false, '')),
        ),
      ),
      seq(oid(O.aes256), oct(iv)),
    ),
  );
  return { alg, encrypted: Buffer.concat([c.update(plain), c.final()]) };
}

/** ContentInfo EncryptedData с SafeContents `safe` (DER), PBES2 с `iterations`. */
function encryptedPart(safe: Buffer, iterations: number) {
  const { alg, encrypted } = pbes2Encrypt(safe, iterations);
  const content = A.create(A.Class.CONTEXT_SPECIFIC, 0, false, encrypted.toString('binary'));
  return seq(oid(O.encryptedData), explicit0(seq(int(0), seq(oid(O.data), alg, content))));
}

/** rsa.p12 с дополнительными частями AuthenticatedSafe; MAC пересчитан (пароль известен автору). */
function withExtraParts(extra: forge.asn1.Asn1[]): Buffer {
  const pfx = A.fromDer(fixture('rsa.p12').toString('binary'));
  const [, authCi, macData] = pfx.value as forge.asn1.Asn1[];
  const octet = ((authCi!.value as forge.asn1.Asn1[])[1]!.value as forge.asn1.Asn1[])[0]!;
  const parts = A.fromDer(octet.value as string);
  (parts.value as forge.asn1.Asn1[]).push(...extra);
  octet.value = A.toDer(parts).getBytes();
  const [digestInfo, macSalt, macIter] = macData!.value as forge.asn1.Asn1[];
  const iter = parseInt(forge.util.bytesToHex(macIter!.value as string), 16);
  const p12 = forge.pkcs12 as unknown as {
    generateKey: (...a: unknown[]) => forge.util.ByteStringBuffer;
  };
  const key = p12.generateKey(
    FIXTURE_PASSWORD,
    forge.util.createBuffer(macSalt!.value as string),
    3,
    iter,
    32,
    forge.md.sha256.create(),
  );
  const hmac = forge.hmac.create();
  hmac.start('sha256', key.getBytes());
  hmac.update(octet.value as string);
  (digestInfo!.value as forge.asn1.Asn1[])[1]!.value = hmac.digest().getBytes();
  return der(pfx);
}

const EMPTY_SAFE = Buffer.from([0x30, 0x00]);

describe('readP12 (§39.1)', () => {
  it('RSA, формат OpenSSL 3: ключ, сертификат, цепочка, сведения', () => {
    const r = read('rsa.p12');
    expect(r.key.asymmetricKeyType).toBe('rsa');
    expect(r.chain).toHaveLength(1);
    expect(r.digestAlg).toBe('SHA-256');
    expect(r.info).toEqual({
      subjectCn: 'Иванов Иван Иванович (rsa)',
      issuer: 'Тестовый УЦ carbone-reports',
      serial: '1001',
      notBefore: expect.any(String),
      notAfter: expect.any(String),
      fingerprint: createHash('sha256').update(r.cert).digest('hex').toUpperCase(),
      keyAlg: 'RSA-2048',
    });
    expect(new Date(r.info.notAfter).getTime()).toBeGreaterThan(Date.now());
    expect(r.chain[0]!.equals(fixtureCertDer('ca.pem'))).toBe(true);
  });

  it('старый формат (-legacy, RC2/3DES) читается так же', () => {
    expect(read('rsa-legacy.p12').info.serial).toBe('1001');
  });

  it('ECDSA P-256 и P-384: алгоритм и хэш', () => {
    expect(read('ec.p12')).toMatchObject({ digestAlg: 'SHA-256', info: { keyAlg: 'ECDSA P-256' } });
    expect(read('ec384.p12')).toMatchObject({
      digestAlg: 'SHA-384',
      info: { keyAlg: 'ECDSA P-384' },
    });
  });

  it('цепочка из трёх: подписант отдельно, два УЦ в chain', () => {
    const r = read('chain3.p12');
    expect(r.info.subjectCn).toBe('Иванов Иван Иванович (chain3)');
    expect(r.chain).toHaveLength(2);
  });

  it('неверный пароль и не PKCS#12 — одна ошибка у пароля', () => {
    fails(() => read('rsa.p12', 'wrong'), 'password', 'неверный пароль или повреждённый файл');
    fails(
      () => readP12(Buffer.from('not a pfx'), 'x'),
      'password',
      'неверный пароль или повреждённый файл',
    );
  });

  it('больше 50 КБ', () => {
    fails(() => readP12(Buffer.alloc(MAX_P12_BYTES + 1), 'x'), 'file', 'файл больше 50 КБ');
  });

  it('нет ключа или нет сертификата к ключу', () => {
    const msg = 'в файле должен быть один ключ и его сертификат';
    fails(() => read('nokey.p12'), 'file', msg);
    fails(() => read('keyonly.p12'), 'file', msg);
  });

  it('слабый ключ, ключ не для подписи', () => {
    fails(() => read('rsa1024.p12'), 'file', 'алгоритм ключа не поддерживается');
    fails(() => read('nosign.p12'), 'file', 'сертификат не предназначен для подписи');
  });

  it('срок действия — на момент проверки', () => {
    fails(
      () => read('rsa.p12', FIXTURE_PASSWORD, new Date('2000-01-01')),
      'file',
      'сертификат ещё не действует',
    );
    fails(
      () => read('rsa.p12', FIXTURE_PASSWORD, new Date('2200-01-01')),
      'file',
      'срок действия сертификата истёк',
    );
  });

  it('ГОСТ — отдельное сообщение до разбора', () => {
    // SEQUENCE { OID 1.2.643.7.1.1.1.1 } — ключ ГОСТ Р 34.10-2012.
    const gost = Buffer.from([
      0x30, 0x0a, 0x06, 0x08, 0x2a, 0x85, 0x03, 0x07, 0x01, 0x01, 0x01, 0x01,
    ]);
    expect(hasGostOid(gost)).toBe(true);
    expect(hasGostOid(fixtureCertDer('ca.pem'))).toBe(false);
    fails(
      () => readP12(gost, 'x'),
      'file',
      'ГОСТ-сертификаты подписываются через КриптоПро — пока не поддерживается',
    );
  });

  it('пароль не попадает в текст ошибки', () => {
    expect.assertions(3);
    try {
      read('rsa.p12', 'секрет-123');
    } catch (e) {
      expect(e).toBeInstanceOf(P12Error);
      expect(String((e as Error).message)).not.toContain('секрет-123');
      expect(JSON.stringify(e)).not.toContain('секрет-123');
    }
  });

  it('OID ИНН 1.2.643.3.131.1.1 — не ГОСТ; сертификат RSA с ИНН принимается', () => {
    const inn = Buffer.from([
      0x30, 0x0a, 0x06, 0x08, 0x2a, 0x85, 0x03, 0x03, 0x81, 0x03, 0x01, 0x01,
    ]);
    expect(hasGostOid(inn)).toBe(false);
    const r = read('rsa-inn.p12');
    expect(r.info.keyAlg).toBe('RSA-2048');
    expect(r.info.subjectCn).toBe('Иванов Иван Иванович (rsa-inn)');
  });

  it('слишком много итераций MAC или шифрования — отказ без расчёта (DoS)', () => {
    const msg = 'файл сертификата не поддерживается: слишком много итераций шифрования';
    expect(MAX_P12_ITERATIONS).toBe(100_000);
    expect(MAX_P12_TOTAL_ITERATIONS).toBe(300_000);
    const getCipher = (forge.pki as unknown as { pbe: { getCipher: unknown } }).pbe.getCipher;
    const t = performance.now();
    // MAC проверяется до пароля: отказ и при неверном пароле.
    fails(() => read('iter-high.p12'), 'file', msg);
    fails(() => read('iter-high.p12', 'wrong'), 'file', msg);
    // MAC — 1 итерация, шифрование — 1 000 000: отказ перед расчётом ключа расшифровки.
    fails(() => read('iter-high-pbe.p12'), 'file', msg);
    expect(performance.now() - t).toBeLessThan(1000);
    // Обёртка снята и после отказа.
    expect((forge.pki as unknown as { pbe: { getCipher: unknown } }).pbe.getCipher).toBe(getCipher);
  });

  it('синтетический файл: дополнительные зашифрованные части в пределах бюджета читаются', () => {
    const file = withExtraParts([encryptedPart(EMPTY_SAFE, 2048), encryptedPart(EMPTY_SAFE, 2048)]);
    expect(read('rsa.p12').info.serial).toBe('1001');
    expect(readP12(file, FIXTURE_PASSWORD).info.serial).toBe('1001');
  });

  it('много зашифрованных частей (каждая в пределе) — общий бюджет, отказ сразу', () => {
    const msg = 'файл сертификата не поддерживается: слишком много итераций шифрования';
    const file = withExtraParts(
      Array.from({ length: 20 }, () => encryptedPart(EMPTY_SAFE, MAX_P12_ITERATIONS)),
    );
    expect(file.length).toBeLessThan(MAX_P12_BYTES);
    const t = performance.now();
    fails(() => readP12(file, FIXTURE_PASSWORD), 'file', msg);
    expect(performance.now() - t).toBeLessThan(500);
  });

  it('ключ внутри зашифрованной части с итерациями сверх предела — отказ до его расчёта', () => {
    const msg = 'файл сертификата не поддерживается: слишком много итераций шифрования';
    // Внутренний pkcs8ShroudedKeyBag виден только после расшифровки внешней части (2048).
    const { alg, encrypted } = pbes2Encrypt(randomBytes(32), 2 * MAX_P12_ITERATIONS);
    const bag = seq(oid(O.shroudedKeyBag), explicit0(seq(alg, oct(encrypted))));
    const file = withExtraParts([encryptedPart(der(seq(bag)), 2048)]);
    const t = performance.now();
    fails(() => readP12(file, FIXTURE_PASSWORD), 'file', msg);
    expect(performance.now() - t).toBeLessThan(500);
  });

  it('скрытые ключи, каждый в пределе, вместе сверх бюджета — отказ до третьего расчёта', () => {
    const msg = 'файл сертификата не поддерживается: слишком много итераций шифрования';
    // Настоящий PKCS#8: node-forge расшифровывает мешок и не падает на нём до проверки следующего.
    const pk8 = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({
      type: 'pkcs8',
      format: 'der',
    });
    const bag = () => {
      const { alg, encrypted } = pbes2Encrypt(pk8, MAX_P12_ITERATIONS);
      return seq(oid(O.shroudedKeyBag), explicit0(seq(alg, oct(encrypted))));
    };
    // Видимая цена мала (MAC и внешняя часть по 2048), три мешка по 100 000 видны только после
    // расшифровки внешней части: два считаются, третий превышает бюджет 300 000.
    const file = withExtraParts([encryptedPart(der(seq(bag(), bag(), bag())), 2048)]);
    expect(file.length).toBeLessThan(MAX_P12_BYTES);
    fails(() => readP12(file, FIXTURE_PASSWORD), 'file', msg);
  }, 30_000);

  it('пароль кириллицей: OpenSSL 3 (PBES2, UTF-8) и -legacy (BMPString)', () => {
    expect(read('rsa-cyr.p12', 'пароль1').info.serial).toBe('1001');
    expect(read('rsa-cyr-legacy.p12', 'пароль1').info.serial).toBe('1001');
    for (const name of ['rsa-cyr.p12', 'rsa-cyr-legacy.p12'])
      fails(() => read(name, 'пароль2'), 'password', 'неверный пароль или повреждённый файл');
  });
});
