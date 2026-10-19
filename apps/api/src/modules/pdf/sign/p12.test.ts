import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { fixture, fixtureCertDer, FIXTURE_PASSWORD } from './fixtures';
import { hasGostOid, MAX_P12_BYTES, P12Error, readP12 } from './p12';

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
    try {
      read('rsa.p12', 'секрет-123');
    } catch (e) {
      expect(String((e as Error).message)).not.toContain('секрет-123');
      expect(JSON.stringify(e)).not.toContain('секрет-123');
    }
  });
});
