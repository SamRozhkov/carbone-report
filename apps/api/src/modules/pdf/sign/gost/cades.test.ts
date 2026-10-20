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

/** Узел BER: тег и либо дочерние узлы, либо содержимое; raw — готовые байты узла целиком. */
type Tlv = { tag: number; kids: Tlv[] | null; body: Uint8Array; raw?: Uint8Array };

/** Разбор DER (определенная длина, однобайтовый тег — как в CMS). */
function parseTlv(b: Uint8Array): Tlv[] {
  const out: Tlv[] = [];
  for (let i = 0; i < b.length;) {
    const tag = b[i]!;
    let len = b[i + 1]!;
    let at = i + 2;
    if (len & 0x80) {
      const n = len & 0x7f;
      len = 0;
      for (let k = 0; k < n; k++) len = len * 256 + b[at + k]!;
      at += n;
    }
    const body = b.subarray(at, at + len);
    out.push({ tag, kids: tag & 0x20 ? parseTlv(body) : null, body });
    i = at + len;
  }
  return out;
}

/** Длина в минимальной форме; zeros — лишние нулевые байты (неминимальная форма BER). */
function lenBytes(n: number, zeros = 0): number[] {
  if (n < 128 && !zeros) return [n];
  const v: number[] = [];
  for (let x = n; x > 0; x = Math.floor(x / 256)) v.unshift(x % 256);
  return [0x80 | (v.length + zeros), ...Array<number>(zeros).fill(0), ...v];
}

/** Кодирование с пересчетом длин; indef(path) — неопределенная длина у составного узла. */
function encodeTlv(t: Tlv, indef: (path: number[]) => boolean = () => false, path = [0]): Buffer {
  if (t.raw) return Buffer.from(t.raw);
  const body = t.kids
    ? Buffer.concat(t.kids.map((k, i) => encodeTlv(k, indef, [...path, i])))
    : Buffer.from(t.body);
  if (t.kids && indef(path))
    return Buffer.concat([Buffer.from([t.tag, 0x80]), body, Buffer.alloc(2)]);
  return Buffer.concat([Buffer.from([t.tag, ...lenBytes(body.length)]), body]);
}

/** SignedData в ContentInfo: SEQUENCE → [0] EXPLICIT → SEQUENCE. */
const signedDataNode = (ci: Tlv) => ci.kids![1]!.kids![0]!;

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

  it('CAdES-T: метка в окне [подготовка − 5 мин, сейчас + 5 мин]', async () => {
    // genTime t-256a.sig — 2026-10-20T15:04:15Z.
    await expect(
      verifyCades(
        input(fx('t-256a.sig'), {
          preparedAt: new Date('2026-10-20T15:09:00Z'),
          now: new Date('2026-10-20T14:59:30Z'),
        }),
      ),
    ).resolves.toMatchObject({ timestamped: true });
  });

  it('BER неопределенной длины: ContentInfo, SignedData и его поля', async () => {
    const ci = parseTlv(fx('bes-256a.sig'))[0]!;
    // Путь [0] — ContentInfo, [0,1] — [0], [0,1,0] — SignedData, [0,1,0,i] — его поля.
    const sig = encodeTlv(ci, (path) => path.length <= 4);
    expect(sig[1]).toBe(0x80);
    expect(sig.length).toBeGreaterThan(fx('bes-256a.sig').length);
    await expect(verifyCades(input(new Uint8Array(sig)))).resolves.toEqual({
      timestamped: false,
      signedAt: null,
    });
  });

  it('сертификат с неминимальной длиной (BER): те же байты в подписи и при подготовке', async () => {
    const der = Buffer.from(pemDer('user256a.pem'));
    const cert = parseTlv(der)[0]!;
    const ber = Buffer.concat([
      Buffer.from([0x30, ...lenBytes(cert.body.length, 1)]),
      Buffer.from(cert.body),
    ]);
    expect(ber.length).toBe(der.length + 1);
    const ci = parseTlv(fx('bes-256a.sig'))[0]!;
    const certs = signedDataNode(ci).kids!.find((k) => k.tag === 0xa0)!;
    expect(certs.kids).toHaveLength(1);
    certs.kids![0] = { ...certs.kids![0]!, raw: ber };
    const sig = new Uint8Array(encodeTlv(ci));
    await expect(verifyCades(input(sig, { certDer: new Uint8Array(ber) }))).resolves.toEqual({
      timestamped: false,
      signedAt: null,
    });
    // Другой сертификат по-прежнему отличается.
    await rejects(
      input(sig, { certDer: pemDer('other256.pem') }),
      'подпись сделана другим сертификатом',
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

  it('метка раньше подготовки − 5 мин или позже сейчас + 5 мин — «метка времени недействительна»', async () => {
    // genTime t-256a.sig — 2026-10-20T15:04:15Z.
    await rejects(
      input(fx('t-256a.sig'), { preparedAt: new Date('2026-10-20T15:09:16Z') }),
      'метка времени недействительна',
    );
    await rejects(
      input(fx('t-256a.sig'), { now: new Date('2026-10-20T14:59:14Z') }),
      'метка времени недействительна',
    );
  });

  it('метка вне срока сертификата подписанта — «метка времени недействительна»', async () => {
    // notBefore user256a — 2026-10-20T15:04:13Z; сдвигаем на 15:04:16, после genTime (15:04:15).
    // Подпись УЦ над сертификатом не проверяется (§42.4), а в подписанные атрибуты он не входит.
    const shift = (b: Uint8Array) => {
      const out = Buffer.from(b);
      const from = Buffer.from('261020150413Z');
      const at = out.indexOf(from);
      expect(at).toBeGreaterThan(0);
      expect(out.indexOf(from, at + 1)).toBe(-1);
      Buffer.from('261020150416Z').copy(out, at);
      return new Uint8Array(out);
    };
    const certDer = shift(pemDer('user256a.pem'));
    await rejects(input(shift(fx('t-256a.sig')), { certDer }), 'метка времени недействительна');
    // Без метки та же подмена принимается (NOW — в новом сроке): отказ выше — именно из-за метки.
    await expect(verifyCades(input(shift(fx('bes-256a.sig')), { certDer }))).resolves.toMatchObject(
      { timestamped: false },
    );
  });

  it('срок сертификата на время метки, а не сервера', async () => {
    // Метка 2026-10-20 — в сроке сертификата, хотя «сейчас» — после его окончания.
    await expect(
      verifyCades(input(fx('t-256a.sig'), { now: new Date('2100-01-01T00:00:00Z') })),
    ).resolves.toMatchObject({ timestamped: true });
  });
});
