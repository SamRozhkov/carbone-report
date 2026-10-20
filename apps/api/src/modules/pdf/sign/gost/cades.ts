// Проверка открепленной подписи CAdES-BES/CAdES-T по ГОСТ (§42.4): разбор pkijs, ГОСТ Р 34.10-2012
// и Стрибог — свои (gost3410.ts, streebog.ts). Цепочка до корня, CRL/OCSP и сертификат службы меток
// не проверяются. Порядок проверок и тексты отказов — §42.4 п. 1–6, первая неудача — отказ.
import { createHash } from 'node:crypto';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { gostPublicKeyFromSpki, verifyGost, type GostPublicKey } from './gost3410';
import { GOST_OID as OID } from './oids';
import { streebog, type StreebogBits } from './streebog';

export type GostHashAlg = 'streebog256' | 'streebog512';

/** Отказ проверки; message — текст §42.4 дословно (показывается пользователю). */
export class CadesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CadesError';
  }
}

export interface CadesInput {
  /** DER ContentInfo с SignedData (открепленная подпись). */
  signature: Uint8Array;
  /** DER сертификата, выбранного при подготовке. */
  certDer: Uint8Array;
  /** Хеш документа (Стрибог hashAlg, порядок байт CMS). */
  hash: Uint8Array;
  hashAlg: GostHashAlg;
  /** Метка времени обязательна (задан SIGN_GOST_TSA_URL). */
  requireTimestamp: boolean;
  now: Date;
  /**
   * Время подготовки: метка не раньше него (минус TIMESTAMP_SKEW_MS). Сертификат службы меток не
   * проверяется (§42.4), поэтому без нижней границы самодельная метка дала бы любое время подписи.
   */
  preparedAt?: Date;
}

/** Допуск на расхождение часов службы меток и сервера (§42.4 п. 5). */
export const TIMESTAMP_SKEW_MS = 5 * 60 * 1000;

export interface CadesResult {
  /** genTime метки времени или null, если метки нет. */
  signedAt: Date | null;
  timestamped: boolean;
}

const E = {
  format: 'неверный формат подписи',
  otherCert: 'подпись сделана другим сертификатом',
  document: 'подпись не соответствует документу',
  invalid: 'подпись недействительна',
  noTimestamp: 'нет метки времени',
  timestamp: 'метка времени недействительна',
  expired: 'срок действия сертификата истёк',
} as const;

const DIGEST_OID: Record<StreebogBits, string> = { 256: OID.streebog256, 512: OID.streebog512 };
const SIGNATURE_OIDS: Record<StreebogBits, readonly string[]> = {
  256: [OID.gost3410_256, OID.signWithDigest256],
  512: [OID.gost3410_512, OID.signWithDigest512],
};
/** Алгоритмы отпечатка метки: Стрибог — свой, SHA-2 — node:crypto. */
const IMPRINT_HASH: Record<string, (d: Uint8Array) => Uint8Array> = {
  [OID.streebog256]: (d) => streebog(256, d),
  [OID.streebog512]: (d) => streebog(512, d),
  [OID.sha256]: (d) => createHash('sha256').update(d).digest(),
  [OID.sha384]: (d) => createHash('sha384').update(d).digest(),
  [OID.sha512]: (d) => createHash('sha512').update(d).digest(),
};

const fail = (text: string): never => {
  throw new CadesError(text);
};
const same = (a: ArrayBuffer | Uint8Array, b: Uint8Array) =>
  Buffer.from(a instanceof Uint8Array ? a : new Uint8Array(a)).equals(Buffer.from(b));
const ab = (b: Uint8Array) => new Uint8Array(b).slice().buffer;
/** Обе стороны сравнения сертификатов кодируются одинаково (pkijs): байты УЦ могут быть не строгим DER. */
const der = (c: pkijs.Certificate) => new Uint8Array(c.toSchema().toBER());

/** Любая ошибка разбора данных из подписи (не CadesError) превращается в отказ с текстом text. */
async function guard<T>(text: string, f: () => T | Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (e instanceof CadesError) throw e;
    throw new CadesError(text);
  }
}

/** ContentInfo (схема asn1js) → SignedData; не SignedData — исключение. */
function signedDataOf(schema: asn1js.AsnType): pkijs.SignedData {
  const ci = new pkijs.ContentInfo({ schema });
  if (ci.contentType !== OID.signedData) throw new Error('не SignedData');
  return new pkijs.SignedData({ schema: ci.content });
}

/** Сертификаты из certificates, подходящие под sid (IssuerAndSerialNumber или SubjectKeyIdentifier). */
function certsBySid(sd: pkijs.SignedData, si: pkijs.SignerInfo): pkijs.Certificate[] {
  const certs = (sd.certificates ?? []).filter(
    (c): c is pkijs.Certificate => c instanceof pkijs.Certificate,
  );
  const sid: unknown = si.sid;
  if (sid instanceof pkijs.IssuerAndSerialNumber)
    return certs.filter(
      (c) => c.issuer.isEqual(sid.issuer) && c.serialNumber.isEqual(sid.serialNumber),
    );
  // [0] SubjectKeyIdentifier — pkijs оставляет блок asn1js как есть: IMPLICIT (примитив, по DER)
  // или, у некоторых кодировщиков, составной с OCTET STRING внутри.
  let want: Uint8Array | null = null;
  if (sid instanceof asn1js.Primitive) want = sid.valueBlock.valueHexView;
  else if (sid instanceof asn1js.Constructed) {
    const inner = sid.valueBlock.value[0];
    if (inner instanceof asn1js.OctetString) want = inner.valueBlock.valueHexView;
  }
  if (!want?.length) return [];
  const ski = want;
  return certs.filter((c) => {
    const ext = c.extensions?.find((x) => x.extnID === OID.subjectKeyIdentifier);
    const value: unknown = ext?.parsedValue;
    return value instanceof asn1js.OctetString && same(value.valueBlock.valueHexView, ski);
  });
}

/** Отказ п. 3 или п. 4 §42.4 (либо null — подписанная часть верна). */
type SignerFailure = 'document' | 'invalid' | null;

/**
 * П. 3–4 §42.4 для одного SignerInfo: digestAlgorithm — Стрибог bits; подписанные атрибуты есть,
 * contentType и messageDigest — по одному и совпадают с ожидаемыми; signatureAlgorithm — ГОСТ
 * Р 34.10-2012 той же длины, ключ той же длины, подпись над DER SET OF атрибутов верна.
 */
function checkSigner(
  si: pkijs.SignerInfo,
  key: GostPublicKey | null,
  bits: StreebogBits,
  contentType: string,
  contentHash: Uint8Array,
): SignerFailure {
  if (si.digestAlgorithm.algorithmId !== DIGEST_OID[bits]) return 'document';
  const attrs = si.signedAttrs?.attributes;
  if (!si.signedAttrs || !attrs?.length) return 'document';
  const ct = attrs.filter((a) => a.type === OID.contentType);
  const md = attrs.filter((a) => a.type === OID.messageDigest);
  if (ct.length !== 1 || md.length !== 1) return 'document';
  const ctValue: unknown = ct[0]!.values.length === 1 ? ct[0]!.values[0] : null;
  if (!(ctValue instanceof asn1js.ObjectIdentifier) || ctValue.getValue() !== contentType)
    return 'document';
  const mdValue: unknown = md[0]!.values.length === 1 ? md[0]!.values[0] : null;
  if (
    !(mdValue instanceof asn1js.OctetString) ||
    !same(mdValue.valueBlock.valueHexView, contentHash)
  )
    return 'document';

  if (!SIGNATURE_OIDS[bits].includes(si.signatureAlgorithm.algorithmId)) return 'invalid';
  if (!key || key.curve.bits !== bits) return 'invalid';
  // Подписывается DER атрибутов с тегом SET (0x31), а не [0] IMPLICIT (как в ../cms.ts).
  const toSign = new Uint8Array(si.signedAttrs.encodedValue.slice(0));
  if (!toSign.length) return 'invalid';
  toSign[0] = 0x31;
  return verifyGost(key, streebog(bits, toSign), si.signature.valueBlock.valueHexView)
    ? null
    : 'invalid';
}

const within = (cert: pkijs.Certificate, at: Date) =>
  at.getTime() >= cert.notBefore.value.getTime() && at.getTime() <= cert.notAfter.value.getTime();

/**
 * П. 5 §42.4: метка signature-time-stamp. Нет — null. Есть — отпечаток от значения подписи,
 * подпись службы (ГОСТ — своим кодом, иначе pkijs, без цепочки), genTime в сроке сертификата
 * подписанта и в окне [подготовка − 5 мин, сейчас + 5 мин]; иначе «метка времени недействительна».
 */
async function checkTimestamp(
  si: pkijs.SignerInfo,
  signerCert: pkijs.Certificate,
  window: { from: number; to: number },
): Promise<Date | null> {
  const tokens = (si.unsignedAttrs?.attributes ?? [])
    .filter((a) => a.type === OID.signatureTimeStamp)
    .flatMap((a) => a.values);
  if (!tokens.length) return null;
  return guard(E.timestamp, async () => {
    if (tokens.length !== 1) return fail(E.timestamp);
    const sd = signedDataOf(tokens[0] as asn1js.AsnType);
    const eContent = sd.encapContentInfo.eContent;
    if (sd.encapContentInfo.eContentType !== OID.tstInfo || !eContent) return fail(E.timestamp);
    if (sd.signerInfos.length !== 1) return fail(E.timestamp);
    const tstBytes = new Uint8Array(eContent.getValue());
    const tst = pkijs.TSTInfo.fromBER(tstBytes);

    const signatureValue = si.signature.valueBlock.valueHexView;
    const imprint = IMPRINT_HASH[tst.messageImprint.hashAlgorithm.algorithmId];
    if (
      !imprint ||
      !same(tst.messageImprint.hashedMessage.valueBlock.valueHexView, imprint(signatureValue))
    )
      return fail(E.timestamp);

    const tsi = sd.signerInfos[0]!;
    const tsaCert = certsBySid(sd, tsi)[0];
    if (!tsaCert) return fail(E.timestamp);
    const gostKey = gostPublicKeyFromSpki(
      new Uint8Array(tsaCert.subjectPublicKeyInfo.toSchema().toBER()),
    );
    if (gostKey) {
      const bits: StreebogBits = tsi.digestAlgorithm.algorithmId === OID.streebog512 ? 512 : 256;
      if (checkSigner(tsi, gostKey, bits, OID.tstInfo, streebog(bits, tstBytes)))
        return fail(E.timestamp);
    } else {
      const ok = await sd.verify({ signer: 0, data: ab(signatureValue), checkChain: false });
      if (ok !== true) return fail(E.timestamp);
    }

    const genTime = tst.genTime;
    if (
      !(genTime instanceof Date) ||
      Number.isNaN(genTime.getTime()) ||
      !within(signerCert, genTime) ||
      genTime.getTime() < window.from ||
      genTime.getTime() > window.to
    )
      return fail(E.timestamp);
    return genTime;
  });
}

/** Проверка открепленной подписи CAdES по §42.4; отказ — CadesError с текстом спецификации. */
export async function verifyCades(i: CadesInput): Promise<CadesResult> {
  const bits: StreebogBits = i.hashAlg === 'streebog512' ? 512 : 256;

  // 1. Формат: SignedData, открепленная, один SignerInfo.
  const sd = await guard(E.format, () => {
    const asn = asn1js.fromBER(i.signature);
    if (asn.offset === -1 || asn.offset !== i.signature.byteLength) throw new Error('не DER');
    const signed = signedDataOf(asn.result);
    if (signed.encapContentInfo.eContent) throw new Error('не открепленная');
    if (signed.signerInfos.length !== 1) throw new Error('не один SignerInfo');
    return signed;
  });
  const si = sd.signerInfos[0]!;

  // 2. Сертификат подписанта (по sid из certificates) — сертификат подготовки.
  const matches = await guard(E.otherCert, () => certsBySid(sd, si));
  const signerCert = await guard(E.otherCert, () => pkijs.Certificate.fromBER(ab(i.certDer)));
  const want = der(signerCert);
  if (!matches.length || !matches.every((c) => same(der(c), want))) fail(E.otherCert);

  // 3–4. Подписанные атрибуты и значение подписи.
  const failure = await guard(E.document, () => {
    if (sd.encapContentInfo.eContentType !== OID.data) return 'document' as const;
    const key = gostPublicKeyFromSpki(
      new Uint8Array(signerCert.subjectPublicKeyInfo.toSchema().toBER()),
    );
    return checkSigner(si, key, bits, OID.data, i.hash);
  });
  if (failure) fail(E[failure]);

  // 5. Метка времени.
  const genTime = await checkTimestamp(si, signerCert, {
    from: i.preparedAt ? i.preparedAt.getTime() - TIMESTAMP_SKEW_MS : -Infinity,
    to: i.now.getTime() + TIMESTAMP_SKEW_MS,
  });
  if (!genTime && i.requireTimestamp) fail(E.noTimestamp);

  // 6. Срок сертификата — на время метки, без нее — на время сервера.
  if (!within(signerCert, genTime ?? i.now)) fail(E.expired);
  return { signedAt: genTime, timestamped: genTime !== null };
}
