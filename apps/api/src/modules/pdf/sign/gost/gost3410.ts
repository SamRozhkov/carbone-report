// Проверка подписи ГОСТ Р 34.10-2012 (256 и 512 бит) на BigInt.
// Секретов здесь нет (только открытый ключ и подпись), поэтому постоянное время не требуется.
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { GOST_CURVES, type GostCurve } from './curves';

export interface GostPublicKey {
  curve: GostCurve;
  x: bigint;
  y: bigint;
}

const KEY_ALGORITHMS: Record<string, 256 | 512> = {
  '1.2.643.7.1.1.1.1': 256, // id-tc26-gost3410-12-256
  '1.2.643.7.1.1.1.2': 512, // id-tc26-gost3410-12-512
};

const mod = (v: bigint, m: bigint) => {
  const r = v % m;
  return r < 0n ? r + m : r;
};

function powMod(base: bigint, exp: bigint, m: bigint): bigint {
  let result = 1n;
  let b = mod(base, m);
  for (let e = exp; e > 0n; e >>= 1n) {
    if (e & 1n) result = (result * b) % m;
    b = (b * b) % m;
  }
  return result;
}

// p и q простые — обратный по малой теореме Ферма.
const inv = (v: bigint, m: bigint) => powMod(v, m - 2n, m);

/** Числа в байтах: big-endian → bigint. */
function intBe(bytes: Uint8Array): bigint {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}
const intLe = (bytes: Uint8Array) => intBe(Uint8Array.from(bytes).reverse());

const onCurve = (c: GostCurve, x: bigint, y: bigint) =>
  x >= 0n && x < c.p && y >= 0n && y < c.p && mod(y * y - (x * x * x + c.a * x + c.b), c.p) === 0n;

// Якобиановы координаты: (X, Y, Z) ↔ (X/Z², Y/Z³); Z = 0 — бесконечно удаленная точка.
type Jac = { x: bigint; y: bigint; z: bigint };
const INF: Jac = { x: 1n, y: 1n, z: 0n };

function dbl(c: GostCurve, P: Jac): Jac {
  const { p } = c;
  if (P.z === 0n || P.y === 0n) return INF;
  const xx = (P.x * P.x) % p;
  const yy = (P.y * P.y) % p;
  const zz = (P.z * P.z) % p;
  const s = (4n * P.x * yy) % p;
  const m = mod(3n * xx + c.a * zz * zz, p);
  const x = mod(m * m - 2n * s, p);
  const y = mod(m * (s - x) - 8n * yy * yy, p);
  const z = (2n * P.y * P.z) % p;
  return { x, y, z };
}

function add(c: GostCurve, P: Jac, Q: Jac): Jac {
  const { p } = c;
  if (P.z === 0n) return Q;
  if (Q.z === 0n) return P;
  const z1z1 = (P.z * P.z) % p;
  const z2z2 = (Q.z * Q.z) % p;
  const u1 = (P.x * z2z2) % p;
  const u2 = (Q.x * z1z1) % p;
  const s1 = (P.y * Q.z * z2z2) % p;
  const s2 = (Q.y * P.z * z1z1) % p;
  if (u1 === u2) return s1 === s2 ? dbl(c, P) : INF;
  const h = mod(u2 - u1, p);
  const r = mod(s2 - s1, p);
  const hh = (h * h) % p;
  const hhh = (h * hh) % p;
  const v = (u1 * hh) % p;
  const x = mod(r * r - hhh - 2n * v, p);
  const y = mod(r * (v - x) - s1 * hhh, p);
  const z = (h * P.z * Q.z) % p;
  return { x, y, z };
}

/** k·P, двоичный метод слева направо. */
function mul(c: GostCurve, P: Jac, k: bigint): Jac {
  let R = INF;
  for (let i = k.toString(2).length - 1; i >= 0; i--) {
    R = dbl(c, R);
    if ((k >> BigInt(i)) & 1n) R = add(c, R, P);
  }
  return R;
}

/**
 * Проверка по ГОСТ Р 34.10-2012 §6.2.
 * hash — байты в порядке CMS/OpenSSL (как streebog()): число e — их little-endian прочтение.
 * signature — значение из CMS (RFC 4491): s ‖ r, каждое big-endian по bits/8 байт.
 * Оба порядка совпадают с движком gost OpenSSL (pkeyutl): подписи raw-*.bin проходят проверку.
 */
export function verifyGost(key: GostPublicKey, hash: Uint8Array, signature: Uint8Array): boolean {
  const c = key.curve;
  const len = c.bits / 8;
  if (hash.length !== len || signature.length !== 2 * len) return false;
  const s = intBe(signature.subarray(0, len));
  const r = intBe(signature.subarray(len));
  if (r <= 0n || r >= c.q || s <= 0n || s >= c.q) return false;
  let e = intLe(hash) % c.q;
  if (e === 0n) e = 1n;
  const v = inv(e, c.q);
  const z1 = (s * v) % c.q;
  const z2 = mod(-r * v, c.q);
  const C = add(
    c,
    mul(c, { x: c.x, y: c.y, z: 1n }, z1),
    mul(c, { x: key.x, y: key.y, z: 1n }, z2),
  );
  if (C.z === 0n) return false;
  const zi = inv(C.z, c.p);
  const x = (C.x * zi * zi) % c.p;
  return x % c.q === r;
}

/**
 * SubjectPublicKeyInfo (DER) → открытый ключ ГОСТ Р 34.10-2012.
 * Параметры алгоритма — SEQUENCE { publicKeyParamSet OID, digestParamSet OID OPTIONAL };
 * subjectPublicKey — BIT STRING с OCTET STRING внутри: x ‖ y, little-endian по bits/8 байт.
 * Не ГОСТ 2012, неизвестный набор параметров или точка вне кривой — null.
 */
export function gostPublicKeyFromSpki(spkiDer: Uint8Array): GostPublicKey | null {
  try {
    const spki = pkijs.PublicKeyInfo.fromBER(Uint8Array.from(spkiDer));
    const bits = KEY_ALGORITHMS[spki.algorithm.algorithmId];
    if (!bits) return null;
    const params = spki.algorithm.algorithmParams as unknown;
    if (!(params instanceof asn1js.Sequence)) return null;
    const paramSet = params.valueBlock.value[0];
    if (!(paramSet instanceof asn1js.ObjectIdentifier)) return null;
    const curve = GOST_CURVES.get(paramSet.valueBlock.toString());
    if (!curve || curve.bits !== bits) return null;

    const inner = asn1js.fromBER(spki.subjectPublicKey.valueBlock.valueHexView);
    if (inner.offset === -1 || !(inner.result instanceof asn1js.OctetString)) return null;
    const point = inner.result.valueBlock.valueHexView;
    const len = bits / 8;
    if (point.length !== 2 * len) return null;
    const x = intLe(point.subarray(0, len));
    const y = intLe(point.subarray(len));
    if (!onCurve(curve, x, y)) return null;
    return { curve, x, y };
  } catch {
    return null;
  }
}
