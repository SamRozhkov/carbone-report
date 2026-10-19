import { createPrivateKey, X509Certificate, type KeyObject } from 'node:crypto';
import type { CertificateInfo } from '@carbone-reports/shared';
import type * as asn1js from 'asn1js';
import forge from 'node-forge';
import * as pkijs from 'pkijs';

export const MAX_P12_BYTES = 50 * 1024;
export type DigestAlg = 'SHA-256' | 'SHA-384';

/** Ошибка у поля формы загрузки сертификата (§39.1); сообщение — для пользователя, без пароля. */
export class P12Error extends Error {
  constructor(
    public readonly field: 'file' | 'password',
    message: string,
  ) {
    super(message);
  }
}

export interface P12Contents {
  key: KeyObject;
  /** DER сертификата подписанта. */
  cert: Buffer;
  /** DER остальных сертификатов файла (цепочка), в порядке файла. */
  chain: Buffer[];
  info: CertificateInfo;
  digestAlg: DigestAlg;
}

const BAD_FILE = 'неверный пароль или повреждённый файл';
const ONE_KEY = 'в файле должен быть один ключ и его сертификат';
const UNSUPPORTED = 'алгоритм ключа не поддерживается';
const GOST = 'ГОСТ-сертификаты подписываются через КриптоПро — пока не поддерживается';

/** Есть OID семейства ГОСТ 1.2.643 (тег 06, длина, байты 2A 85 03) — R5. */
export function hasGostOid(der: Uint8Array): boolean {
  for (let i = 0; i + 4 < der.length; i++)
    if (der[i] === 0x06 && der[i + 2] === 0x2a && der[i + 3] === 0x85 && der[i + 4] === 0x03)
      return true;
  return false;
}

type Bag = forge.pkcs12.Bag & { asn1?: forge.asn1.Asn1 };

const toDer = (a: forge.asn1.Asn1) => Buffer.from(forge.asn1.toDer(a).getBytes(), 'binary');

function openPfx(file: Uint8Array, password: string): forge.pkcs12.Pkcs12Pfx {
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(Buffer.from(file).toString('binary')));
    return forge.pkcs12.pkcs12FromAsn1(asn1, true, password);
  } catch {
    // Причина (MAC, ASN.1) пользователю не нужна и может повторять входные данные.
    throw new P12Error('password', BAD_FILE);
  }
}

function bags(p12: forge.pkcs12.Pkcs12Pfx, type: string): Bag[] {
  return (p12.getBags({ bagType: type })[type] ?? []) as Bag[];
}

function keyAlg(key: KeyObject): { name: string; digestAlg: DigestAlg } | null {
  const d = key.asymmetricKeyDetails ?? {};
  if (key.asymmetricKeyType === 'rsa' && (d.modulusLength ?? 0) >= 2048)
    return { name: `RSA-${d.modulusLength}`, digestAlg: 'SHA-256' };
  if (key.asymmetricKeyType === 'ec' && d.namedCurve === 'prime256v1')
    return { name: 'ECDSA P-256', digestAlg: 'SHA-256' };
  if (key.asymmetricKeyType === 'ec' && d.namedCurve === 'secp384r1')
    return { name: 'ECDSA P-384', digestAlg: 'SHA-384' };
  return null;
}

const OID_CN = '2.5.4.3';
const OID_KEY_USAGE = '2.5.29.15';

function commonName(n: pkijs.RelativeDistinguishedNames): string | undefined {
  const cn = n.typesAndValues.find((t) => t.type === OID_CN);
  return cn ? String(cn.value.valueBlock.value) : undefined;
}

/** `keyUsage` нет — подпись не запрещена; есть — нужен digitalSignature или nonRepudiation. */
function allowsSigning(c: pkijs.Certificate): boolean {
  const ext = c.extensions?.find((e) => e.extnID === OID_KEY_USAGE);
  if (!ext) return true;
  const bits = (ext.parsedValue as asn1js.BitString).valueBlock.valueHexView;
  return ((bits[0] ?? 0) & 0xc0) !== 0;
}

export function certInfo(der: Uint8Array, keyAlgName: string): CertificateInfo {
  const x = new X509Certificate(der);
  const c = pkijs.Certificate.fromBER(der as BufferSource);
  return {
    subjectCn: commonName(c.subject) ?? x.subject.split('\n').join(', '),
    issuer: commonName(c.issuer) ?? x.issuer.split('\n').join(', '),
    serial: x.serialNumber.toUpperCase(),
    notBefore: new Date(x.validFrom).toISOString(),
    notAfter: new Date(x.validTo).toISOString(),
    fingerprint: x.fingerprint256.replaceAll(':', '').toUpperCase(),
    keyAlg: keyAlgName,
  };
}

/** Открывает `.p12` паролем и проверяет пригодность для подписи (§39.1). */
export function readP12(file: Uint8Array, password: string, now = new Date()): P12Contents {
  if (file.length > MAX_P12_BYTES) throw new P12Error('file', 'файл больше 50 КБ');
  if (hasGostOid(file)) throw new P12Error('file', GOST);
  const p12 = openPfx(file, password);
  const oids = forge.pki.oids;
  const keyBags = [...bags(p12, oids.pkcs8ShroudedKeyBag!), ...bags(p12, oids.keyBag!)];
  const certs = bags(p12, oids.certBag!).map((b) =>
    toDer(b.cert ? forge.pki.certificateToAsn1(b.cert) : b.asn1!),
  );
  if (keyBags.length !== 1) throw new P12Error('file', ONE_KEY);
  const kb = keyBags[0]!;
  const pkcs8 = toDer(
    kb.key
      ? forge.pki.wrapRsaPrivateKey(forge.pki.privateKeyToAsn1(kb.key as forge.pki.rsa.PrivateKey))
      : kb.asn1!,
  );
  if (hasGostOid(pkcs8) || certs.some((c) => hasGostOid(c))) throw new P12Error('file', GOST);
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
  } catch {
    throw new P12Error('file', UNSUPPORTED);
  }
  const idx = certs.findIndex((c) => {
    try {
      return new X509Certificate(c).checkPrivateKey(key);
    } catch {
      return false;
    }
  });
  if (idx < 0) throw new P12Error('file', ONE_KEY);
  const alg = keyAlg(key);
  if (!alg) throw new P12Error('file', UNSUPPORTED);
  const cert = certs[idx]!;
  const x = new X509Certificate(cert);
  if (now < new Date(x.validFrom)) throw new P12Error('file', 'сертификат ещё не действует');
  if (now > new Date(x.validTo)) throw new P12Error('file', 'срок действия сертификата истёк');
  if (!allowsSigning(pkijs.Certificate.fromBER(cert)))
    throw new P12Error('file', 'сертификат не предназначен для подписи');
  return {
    key,
    cert,
    chain: certs.filter((_, i) => i !== idx),
    info: certInfo(cert, alg.name),
    digestAlg: alg.digestAlg,
  };
}
