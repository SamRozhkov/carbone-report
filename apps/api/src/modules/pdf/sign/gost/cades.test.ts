import { readFileSync } from 'node:fs';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { describe, expect, it } from 'vitest';
import { CadesError, verifyCades, type CadesInput, type GostHashAlg } from './cades';
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
const doc = fx('doc.pdf');
const NOW = new Date('2026-10-20T16:00:00Z');

const input = (sig: Uint8Array, over: Partial<CadesInput> = {}): CadesInput => {
  const hashAlg: GostHashAlg = over.hashAlg ?? 'streebog256';
  return {
    signature: sig,
    certDer: pemDer('user256a.pem'),
    hash: streebog(hashAlg === 'streebog512' ? 512 : 256, doc),
    hashAlg,
    requireTimestamp: false,
    now: NOW,
    ...over,
  };
};

const rejects = (i: CadesInput, text: string) =>
  expect(verifyCades(i)).rejects.toSatisfy(
    (e: unknown) => e instanceof CadesError && e.message === text,
  );

/** Токен метки из неподписанного атрибута первого SignerInfo. */
function tokenOf(sig: Uint8Array) {
  const sd = new pkijs.SignedData({
    schema: pkijs.ContentInfo.fromBER(new Uint8Array(sig)).content,
  });
  const value = sd.signerInfos[0]!.unsignedAttrs!.attributes[0]!.values[0] as asn1js.Sequence;
  return { sd, value };
}

/** Испорченный последний байт значения подписи службы внутри токена (байты на месте). */
function corruptTokenSignature(sig: Uint8Array): Uint8Array {
  const { value } = tokenOf(sig);
  const token = new pkijs.SignedData({ schema: new pkijs.ContentInfo({ schema: value }).content });
  const tsaSig = Buffer.from(token.signerInfos[0]!.signature.valueBlock.valueHexView);
  const out = Buffer.from(sig);
  const at = out.indexOf(tsaSig);
  expect(at).toBeGreaterThan(0);
  out[at + tsaSig.length - 1]! ^= 1;
  return new Uint8Array(out);
}

/** Токен метки из `from` переносится в подпись `to` (отпечаток с ней не сходится). */
function transplantToken(from: Uint8Array, to: Uint8Array): Uint8Array {
  const { value } = tokenOf(from);
  const sd = new pkijs.SignedData({
    schema: pkijs.ContentInfo.fromBER(new Uint8Array(to)).content,
  });
  sd.signerInfos[0]!.unsignedAttrs = new pkijs.SignedAndUnsignedAttributes({
    type: 1,
    attributes: [new pkijs.Attribute({ type: '1.2.840.113549.1.9.16.2.14', values: [value] })],
  });
  return new Uint8Array(
    new pkijs.ContentInfo({ contentType: '1.2.840.113549.1.7.2', content: sd.toSchema(true) })
      .toSchema()
      .toBER(),
  );
}

describe('verifyCades — успех', () => {
  it('CAdES-BES 256 tc26 A', async () => {
    await expect(verifyCades(input(fx('bes-256a.sig')))).resolves.toEqual({
      timestamped: false,
      signedAt: null,
    });
  });

  it('CAdES-BES 256 CryptoPro A', async () => {
    await expect(
      verifyCades(input(fx('bes-256cp.sig'), { certDer: pemDer('user256cp.pem') })),
    ).resolves.toEqual({ timestamped: false, signedAt: null });
  });

  it('CAdES-BES 512', async () => {
    await expect(
      verifyCades(
        input(fx('bes-512a.sig'), { certDer: pemDer('user512a.pem'), hashAlg: 'streebog512' }),
      ),
    ).resolves.toEqual({ timestamped: false, signedAt: null });
  });

  it('лишние атрибуты (signingTime) и цепочка в certificates', async () => {
    await expect(verifyCades(input(fx('bes-256a-chain.sig')))).resolves.toEqual({
      timestamped: false,
      signedAt: null,
    });
  });

  it('CAdES-T, метка ГОСТ: signedAt — genTime', async () => {
    await expect(verifyCades(input(fx('t-256a.sig'), { requireTimestamp: true }))).resolves.toEqual(
      { timestamped: true, signedAt: new Date('2026-10-20T15:04:15Z') },
    );
  });

  it('CAdES-T, метка RSA, отпечаток SHA-256', async () => {
    await expect(
      verifyCades(input(fx('t-256a-rsa.sig'), { requireTimestamp: true })),
    ).resolves.toEqual({ timestamped: true, signedAt: new Date('2026-10-20T15:04:15Z') });
  });
});

describe('verifyCades — отказы по порядку §42.4', () => {
  it('мусор и вложенное содержимое — «неверный формат подписи»', async () => {
    await rejects(input(new Uint8Array([1, 2, 3, 4])), 'неверный формат подписи');
    await rejects(input(new Uint8Array()), 'неверный формат подписи');
    await rejects(input(doc), 'неверный формат подписи');
    await rejects(input(fx('with-content.sig')), 'неверный формат подписи');
  });

  it('другой сертификат', async () => {
    await rejects(
      input(fx('bes-256a.sig'), { certDer: pemDer('other256.pem') }),
      'подпись сделана другим сертификатом',
    );
    await rejects(input(fx('bes-256a-other.sig')), 'подпись сделана другим сертификатом');
  });

  it('хеш не тот, длина хеша не та, атрибутов нет — «подпись не соответствует документу»', async () => {
    await rejects(input(fx('bad-hash.sig')), 'подпись не соответствует документу');
    await rejects(
      input(fx('bes-256a.sig'), { hashAlg: 'streebog512' }),
      'подпись не соответствует документу',
    );
    await rejects(
      input(fx('bes-512a.sig'), { certDer: pemDer('user512a.pem') }),
      'подпись не соответствует документу',
    );
    await rejects(input(fx('no-attrs.sig')), 'подпись не соответствует документу');
  });

  it('испорченное значение подписи — «подпись недействительна»', async () => {
    await rejects(input(fx('bad-value.sig')), 'подпись недействительна');
  });

  it('метка обязательна, а ее нет', async () => {
    await rejects(input(fx('bes-256a.sig'), { requireTimestamp: true }), 'нет метки времени');
  });

  it('испорченная подпись метки (ГОСТ и RSA) — «метка времени недействительна»', async () => {
    await rejects(input(corruptTokenSignature(fx('t-256a.sig'))), 'метка времени недействительна');
    await rejects(
      input(corruptTokenSignature(fx('t-256a-rsa.sig'))),
      'метка времени недействительна',
    );
  });

  it('отпечаток метки не от этой подписи — «метка времени недействительна»', async () => {
    const sig = transplantToken(fx('t-256a.sig'), fx('bes-256a-chain.sig'));
    await expect(verifyCades(input(fx('bes-256a-chain.sig')))).resolves.toBeTruthy();
    await rejects(input(sig), 'метка времени недействительна');
  });

  it('без метки срок — на время сервера: после notAfter и до notBefore — отказ', async () => {
    await rejects(
      input(fx('bes-256a.sig'), { now: new Date('2100-01-01T00:00:00Z') }),
      'срок действия сертификата истёк',
    );
    await rejects(
      input(fx('bes-256a.sig'), { now: new Date('2000-01-01T00:00:00Z') }),
      'срок действия сертификата истёк',
    );
  });

  it('срок сертификата на время метки, а не сервера', async () => {
    // Метка 2026-10-20 — в сроке сертификата, хотя «сейчас» — после его окончания.
    await expect(
      verifyCades(input(fx('t-256a.sig'), { now: new Date('2100-01-01T00:00:00Z') })),
    ).resolves.toMatchObject({ timestamped: true });
  });
});
