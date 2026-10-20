import { createPrivateKey, X509Certificate, type KeyObject } from 'node:crypto';
import type { CertificateInfo } from '@carbone-reports/shared';
import type * as asn1js from 'asn1js';
import forge from 'node-forge';
import * as pkijs from 'pkijs';

export const MAX_P12_BYTES = 50 * 1024;
/** Допустимые алгоритмы хеша: единый список для типа и схемы ответа потока. */
export const DIGEST_ALGS = ['SHA-256', 'SHA-384'] as const;
export type DigestAlg = (typeof DIGEST_ALGS)[number];

/** Ошибка у поля формы загрузки сертификата (§39.1); сообщение — для пользователя, без пароля. */
export class P12Error extends Error {
  constructor(
    public readonly field: 'file' | 'password',
    message: string,
  ) {
    super(message);
    this.name = 'P12Error';
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

/** Начала содержимого OID алгоритмов ГОСТ: 1.2.643.2.2.* (КриптоПро) и 1.2.643.7.1.* (ГОСТ Р 34.10/34.11-2012). */
const GOST_ARCS = [
  [0x2a, 0x85, 0x03, 0x02, 0x02],
  [0x2a, 0x85, 0x03, 0x07, 0x01],
];

/**
 * Есть OID алгоритма ГОСТ (тег 06, длина, затем 2A 85 03 02 02 или 2A 85 03 07 01) — R5.
 * Прочие OID ветки 1.2.643 (ИНН, ОГРН, СНИЛС, политики) — обычные поля российских сертификатов.
 */
export function hasGostOid(der: Uint8Array): boolean {
  for (let i = 0; i + 6 < der.length; i++)
    if (der[i] === 0x06 && GOST_ARCS.some((a) => a.every((b, j) => der[i + 2 + j] === b)))
      return true;
  return false;
}

const isGostAlgorithm = (oid: string) =>
  oid.startsWith('1.2.643.2.2.') || oid.startsWith('1.2.643.7.1.');

type Bag = forge.pkcs12.Bag & { asn1?: forge.asn1.Asn1 };

const toDer = (a: forge.asn1.Asn1) => Buffer.from(forge.asn1.toDer(a).getBytes(), 'binary');

/**
 * Пределы итераций PBKDF2/PKCS#12 KDF. `node-forge` считает их синхронно в главном потоке
 * (1 000 000 — секунды), а итерации и число зашифрованных частей задаёт автор файла.
 * Предел на один расчёт ключа и общий бюджет на разбор файла: MAC плюс все расшифровки
 * (SafeContents и ключи), иначе файл из многих зашифрованных частей умножает время.
 */
export const MAX_P12_ITERATIONS = 100_000;
export const MAX_P12_TOTAL_ITERATIONS = 300_000;
const TOO_MANY_ITERATIONS = 'файл сертификата не поддерживается: слишком много итераций шифрования';
const tooManyIterations = () => new P12Error('file', TOO_MANY_ITERATIONS);

type Asn1 = forge.asn1.Asn1;
const children = (a: Asn1 | undefined): Asn1[] =>
  a && Array.isArray(a.value) ? (a.value as Asn1[]) : [];

/** Значение INTEGER; длиннее 4 байт (без ведущих нулей) — заведомо больше предела. */
function intValue(a: Asn1 | undefined): number | null {
  if (!a || a.tagClass !== forge.asn1.Class.UNIVERSAL || a.type !== forge.asn1.Type.INTEGER)
    return null;
  if (typeof a.value !== 'string') return null;
  const bytes = a.value.replace(/^\0+/, '');
  if (bytes.length > 4) return Number.MAX_SAFE_INTEGER;
  let n = 0;
  for (const ch of bytes) n = n * 256 + ch.charCodeAt(0);
  return n;
}

/**
 * Итерации MAC (`macData.iterations`) — их `node-forge` считает первыми, до расшифровки.
 * PFX ::= SEQUENCE { version, authSafe ContentInfo, macData MacData OPTIONAL },
 * MacData ::= SEQUENCE { mac DigestInfo, macSalt OCTET STRING, iterations INTEGER DEFAULT 1 }.
 */
function macIterations(pfx: Asn1): number {
  const mac = children(pfx)[2];
  if (!mac) return 0;
  const n = intValue(children(mac)[2]) ?? 1;
  if (n > MAX_P12_ITERATIONS) throw tooManyIterations();
  return n;
}

/**
 * Итерации параметров PBE: PKCS#12 PBE-params ::= SEQUENCE { salt, iterations INTEGER };
 * PBES2-params ::= SEQUENCE { keyDerivationFunc SEQUENCE { pbkdf2 OID,
 * PBKDF2-params SEQUENCE { salt, iterationCount INTEGER, ... } }, encryptionScheme }.
 */
function pbeIterations(oid: string, params: Asn1): number | null {
  if (oid === forge.pki.oids.pkcs5PBES2)
    return intValue(children(children(children(params)[0])[1])[1]);
  return intValue(children(params)[1]);
}

/** Цена расчёта ключа в итерациях: PBE PKCS#12 выводит ключ и IV отдельно (×2), PBES2 — один раз. */
function pbeCost(oid: string, params: Asn1 | undefined): number {
  const n = (params && pbeIterations(oid, params)) ?? 0;
  if (n > MAX_P12_ITERATIONS) throw tooManyIterations();
  return oid === forge.pki.oids.pkcs5PBES2 ? n : 2 * n;
}

/** Содержимое OCTET STRING (в BER может быть составным). */
function octets(a: Asn1 | undefined): string | null {
  if (!a || a.type !== forge.asn1.Type.OCTETSTRING) return null;
  if (typeof a.value === 'string') return a.value;
  return children(a)
    .map((c) => (typeof c.value === 'string' ? c.value : ''))
    .join('');
}

const oidOf = (a: Asn1 | undefined) =>
  a && a.type === forge.asn1.Type.OID && typeof a.value === 'string'
    ? forge.asn1.derToOid(a.value)
    : '';

/** Алгоритм шифрования: AlgorithmIdentifier ::= SEQUENCE { algorithm OID, parameters }. */
const algCost = (alg: Asn1 | undefined) => pbeCost(oidOf(children(alg)[0]), children(alg)[1]);

/**
 * Итерации, видимые до расшифровки: зашифрованные части AuthenticatedSafe (EncryptedData) и
 * pkcs8ShroudedKeyBag в открытых частях. Сумма с MAC больше бюджета — отказ сразу, без расчётов.
 * Ключи внутри зашифрованных частей видны только после расшифровки — их считает withPbeGuard.
 * Структура не та — 0: такой файл отвергнет сам `node-forge`.
 */
function visibleCost(pfx: Asn1): number {
  const authSafe = octets(children(children(children(pfx)[1])[1])[0]);
  if (authSafe === null) return 0;
  let parts: Asn1[];
  try {
    parts = children(forge.asn1.fromDer(authSafe));
  } catch {
    return 0;
  }
  const oids = forge.pki.oids;
  let total = 0;
  for (const ci of parts) {
    const [type, wrapped] = children(ci);
    const content = children(wrapped)[0];
    if (oidOf(type) === oids.encryptedData) {
      // EncryptedData ::= SEQUENCE { version, EncryptedContentInfo SEQUENCE { contentType, alg, … } }
      total += algCost(children(children(content)[1])[1]);
    } else if (oidOf(type) === oids.data) {
      const safe = octets(content);
      if (safe === null) continue;
      let bagList: Asn1[];
      try {
        bagList = children(forge.asn1.fromDer(safe));
      } catch {
        continue;
      }
      // SafeBag ::= SEQUENCE { bagId, [0] bagValue, … }; EncryptedPrivateKeyInfo ::= SEQUENCE { alg, data }
      for (const bag of bagList)
        if (oidOf(children(bag)[0]) === oids.pkcs8ShroudedKeyBag)
          total += algCost(children(children(children(bag)[1])[0])[0]);
    }
  }
  return total;
}

type GetCipher = (oid: string, params: Asn1, password: string) => unknown;
const pbe = (forge.pki as unknown as { pbe: { getCipher: GetCipher } }).pbe;

/**
 * На время синхронного разбора `node-forge` оборачивает `pki.pbe.getCipher` — через него идёт
 * расшифровка всех SafeContents и всех pkcs8ShroudedKeyBag, в том числе мешков внутри
 * зашифрованных SafeContents (их параметры видны только после внешней расшифровки), так что
 * итерации проверяются перед каждым расчётом ключа: предел на расчёт и общий бюджет разбора
 * (начинается с итераций MAC). PBE PKCS#12 (-legacy) выводит ключ и IV отдельно — счёт ×2.
 * Заодно пароль для PBES2 (PBKDF2) передаётся байтами UTF-8, как его кодирует OpenSSL 3 (иначе
 * пароль не латиницей не подходит); MAC и PBE PKCS#12 `node-forge` сам переводит в BMPString.
 */
function withPbeGuard<T>(spent: number, fn: () => T): T {
  const original = pbe.getCipher;
  pbe.getCipher = (oid, params, password) => {
    spent += pbeCost(oid, params);
    if (spent > MAX_P12_TOTAL_ITERATIONS) throw tooManyIterations();
    const pbes2 = oid === forge.pki.oids.pkcs5PBES2;
    return original.call(pbe, oid, params, pbes2 ? forge.util.encodeUtf8(password) : password);
  };
  try {
    return fn();
  } finally {
    pbe.getCipher = original;
  }
}

function openPfx(file: Uint8Array, password: string): forge.pkcs12.Pkcs12Pfx {
  try {
    const asn1 = forge.asn1.fromDer(forge.util.createBuffer(Buffer.from(file).toString('binary')));
    const mac = macIterations(asn1);
    if (mac + visibleCost(asn1) > MAX_P12_TOTAL_ITERATIONS) throw tooManyIterations();
    return withPbeGuard(mac, () => forge.pkcs12.pkcs12FromAsn1(asn1, true, password));
  } catch (e) {
    if (e instanceof P12Error) throw e;
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
  // Разбор чужих структур: любая ошибка — «странный» файл, а не 500.
  let parsed: pkijs.Certificate[];
  let keyOid: string;
  try {
    parsed = certs.map((c) => pkijs.Certificate.fromBER(c as BufferSource));
    keyOid = pkijs.PrivateKeyInfo.fromBER(pkcs8 as BufferSource).privateKeyAlgorithm.algorithmId;
  } catch {
    throw new P12Error('file', ONE_KEY);
  }
  if (
    isGostAlgorithm(keyOid) ||
    parsed.some((c) => isGostAlgorithm(c.subjectPublicKeyInfo.algorithm.algorithmId))
  )
    throw new P12Error('file', GOST);
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
  let signing: boolean;
  let info: CertificateInfo;
  try {
    signing = allowsSigning(parsed[idx]!);
    info = certInfo(cert, alg.name);
  } catch {
    throw new P12Error('file', ONE_KEY);
  }
  if (!signing) throw new P12Error('file', 'сертификат не предназначен для подписи');
  return {
    key,
    cert,
    chain: certs.filter((_, i) => i !== idx),
    info,
    digestAlg: alg.digestAlg,
  };
}
