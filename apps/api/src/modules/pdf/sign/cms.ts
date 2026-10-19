import { createHash, sign, type KeyObject } from 'node:crypto';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import type { DigestAlg } from './p12';

export const OID = {
  data: '1.2.840.113549.1.7.1',
  signedData: '1.2.840.113549.1.7.2',
  tstInfo: '1.2.840.113549.1.9.16.1.4',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingCertV2: '1.2.840.113549.1.9.16.2.47',
  timeStampToken: '1.2.840.113549.1.9.16.2.14',
  sha256: '2.16.840.1.101.3.4.2.1',
  sha384: '2.16.840.1.101.3.4.2.2',
  sha256WithRsa: '1.2.840.113549.1.1.11',
  sha384WithRsa: '1.2.840.113549.1.1.12',
  ecdsaWithSha256: '1.2.840.10045.4.3.2',
  ecdsaWithSha384: '1.2.840.10045.4.3.3',
} as const;

const ab = (b: Uint8Array) => new Uint8Array(b).slice().buffer;
export const nodeHash = (alg: DigestAlg) => (alg === 'SHA-384' ? 'sha384' : 'sha256');

export interface SignedDataInput {
  key: KeyObject;
  /** DER сертификата подписанта. */
  cert: Uint8Array;
  chain: Uint8Array[];
  digestAlg: DigestAlg;
  /** Хэш содержимого (digestAlg). */
  digest: Uint8Array;
  /** Тип содержимого; по умолчанию id-data (подпись PDF). */
  contentType?: string;
  /** Вложенное содержимое (TSTInfo метки времени); нет — отделённая подпись. */
  eContent?: Uint8Array;
  /** Неподписанные атрибуты по готовому значению подписи (метка времени). */
  unsigned?: (signature: Uint8Array) => Promise<pkijs.Attribute[]>;
}

/** signing-certificate-v2: ESSCertIDv2 с SHA-256 сертификата (алгоритм по умолчанию не пишется, issuerSerial нет). */
function signingCertificateV2(cert: Uint8Array): asn1js.Sequence {
  const hash = createHash('sha256').update(cert).digest();
  return new asn1js.Sequence({
    value: [
      new asn1js.Sequence({
        value: [new asn1js.Sequence({ value: [new asn1js.OctetString({ valueHex: ab(hash) })] })],
      }),
    ],
  });
}

function signatureOid(key: KeyObject, alg: DigestAlg): string {
  if (key.asymmetricKeyType === 'rsa')
    return alg === 'SHA-384' ? OID.sha384WithRsa : OID.sha256WithRsa;
  return alg === 'SHA-384' ? OID.ecdsaWithSha384 : OID.ecdsaWithSha256;
}

/**
 * CMS SignedData (PAdES baseline B-B, §39.4): подписанные атрибуты contentType, messageDigest,
 * signing-certificate-v2, без signingTime. Порядок — DER SET OF (RFC 5652 §5.4): по возрастанию
 * байт кодировки атрибута; pkijs сам не сортирует, а длина messageDigest зависит от хэша.
 * Подпись — crypto.sign Node: RSA PKCS#1 v1.5, ECDSA в DER (R2).
 */
export async function buildSignedData(i: SignedDataInput): Promise<Uint8Array> {
  const contentType = i.contentType ?? OID.data;
  const cert = pkijs.Certificate.fromBER(ab(i.cert));
  const digestOid = i.digestAlg === 'SHA-384' ? OID.sha384 : OID.sha256;
  const attrs = [
    new pkijs.Attribute({
      type: OID.contentType,
      values: [new asn1js.ObjectIdentifier({ value: contentType })],
    }),
    new pkijs.Attribute({
      type: OID.messageDigest,
      values: [new asn1js.OctetString({ valueHex: ab(i.digest) })],
    }),
    new pkijs.Attribute({ type: OID.signingCertV2, values: [signingCertificateV2(i.cert)] }),
  ];
  const der = (a: pkijs.Attribute) => Buffer.from(a.toSchema().toBER());
  attrs.sort((a, b) => Buffer.compare(der(a), der(b)));
  const signedAttrs = new pkijs.SignedAndUnsignedAttributes({ type: 0, attributes: attrs });
  // Подписывается DER атрибутов с тегом SET (0x31), а не [0] IMPLICIT.
  const toSign = new Uint8Array(signedAttrs.toSchema().toBER());
  toSign[0] = 0x31;
  const signature = sign(nodeHash(i.digestAlg), toSign, i.key);
  const signerInfo = new pkijs.SignerInfo({
    version: 1,
    sid: new pkijs.IssuerAndSerialNumber({ issuer: cert.issuer, serialNumber: cert.serialNumber }),
    digestAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: digestOid }),
    signedAttrs,
    signatureAlgorithm: new pkijs.AlgorithmIdentifier({
      algorithmId: signatureOid(i.key, i.digestAlg),
      ...(i.key.asymmetricKeyType === 'rsa' ? { algorithmParams: new asn1js.Null() } : {}),
    }),
    signature: new asn1js.OctetString({ valueHex: ab(signature) }),
  });
  const unsigned = i.unsigned ? await i.unsigned(signature) : [];
  if (unsigned.length)
    signerInfo.unsignedAttrs = new pkijs.SignedAndUnsignedAttributes({
      type: 1,
      attributes: unsigned,
    });
  const signed = new pkijs.SignedData({
    version: contentType === OID.data ? 1 : 3,
    encapContentInfo: new pkijs.EncapsulatedContentInfo({
      eContentType: contentType,
      ...(i.eContent ? { eContent: new asn1js.OctetString({ valueHex: ab(i.eContent) }) } : {}),
    }),
    digestAlgorithms: [new pkijs.AlgorithmIdentifier({ algorithmId: digestOid })],
    certificates: [i.cert, ...i.chain].map((d) => pkijs.Certificate.fromBER(ab(d))),
    signerInfos: [signerInfo],
  });
  return new Uint8Array(
    new pkijs.ContentInfo({ contentType: OID.signedData, content: signed.toSchema(true) })
      .toSchema()
      .toBER(),
  );
}

/** Неподписанный атрибут signature-time-stamp (B-T). */
export function timestampAttribute(token: Uint8Array): pkijs.Attribute {
  return new pkijs.Attribute({
    type: OID.timeStampToken,
    values: [asn1js.fromBER(ab(token)).result],
  });
}
