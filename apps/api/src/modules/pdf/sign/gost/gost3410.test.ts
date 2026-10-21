import { readFileSync } from 'node:fs';
import * as pkijs from 'pkijs';
import { describe, expect, it } from 'vitest';
import { GOST_CURVES, type GostCurve } from './curves';
import { gostPublicKeyFromSpki, verifyGost, type GostPublicKey } from './gost3410';
import { streebog } from './streebog';

const fx = (dir: string, n: string) =>
  readFileSync(new URL(`../../../../../test/fixtures/${dir}/${n}`, import.meta.url));
const certDer = (dir: string, n: string) =>
  Buffer.from(
    fx(dir, n)
      .toString()
      .replace(/-----[^-]+-----/g, '')
      .replace(/\s/g, ''),
    'base64',
  );
const spkiOf = (dir: string, n: string) =>
  new Uint8Array(
    pkijs.Certificate.fromBER(certDer(dir, n)).subjectPublicKeyInfo.toSchema().toBER(),
  );
const keyOf = (n: string) => {
  const key = gostPublicKeyFromSpki(spkiOf('gost', n));
  if (!key) throw new Error(`нет ключа ГОСТ в ${n}`);
  return key;
};

const be = (v: bigint, len: number) =>
  Uint8Array.from({ length: len }, (_, i) => Number((v >> BigInt(8 * (len - 1 - i))) & 0xffn));
const le = (v: bigint, len: number) => be(v, len).reverse();
// Формы RFC 4491: хеш — little-endian числа e, подпись — s ‖ r (каждое big-endian).
const sigBytes = (r: bigint, s: bigint, len: number) =>
  new Uint8Array([...be(s, len), ...be(r, len)]);

// ГОСТ Р 34.10-2012, приложение А.1 (оно же RFC 7091 §7): тестовая кривая 256 бит.
const A1_CURVE: GostCurve = {
  oid: 'test-a1',
  bits: 256,
  p: 0x8000000000000000000000000000000000000000000000000000000000000431n,
  a: 7n,
  b: 0x5fbff498aa938ce739b8e022fbafef40563f6e6a3472fc2a514c0ce9dae23b7en,
  q: 0x8000000000000000000000000000000150fe8a1892976154c59cfc193accf5b3n,
  x: 2n,
  y: 0x8e2a8a0e65147d4bd6316030e16d19c85c97f0a9ca267122b96abbcea7e8fc8n,
};
const A1 = {
  key: {
    curve: A1_CURVE,
    x: 0x7f2b49e270db6d90d8595bec458b50c58585ba1d4e9b788f6689dbd8e56fd80bn,
    y: 0x26f1b489d6701dd185c8413a977b3cbbaf64d1c593d26627dffb101a87ff77dan,
  } satisfies GostPublicKey,
  e: 0x2dfbc1b372d89a1188c09c52e0eec61fce52032ab1022e8e67ece6672b043ee5n,
  r: 0x41aa28d2f1ab148280cd9ed56feda41974053554a42767b83ad043fd39dc0493n,
  s: 0x1456c64ba4642a1653c235a98a60249bcd6d3f746b631df928014f6c5bf9c40n,
};

// ГОСТ Р 34.10-2012, приложение А.2: тестовая кривая 512 бит.
const A2_CURVE: GostCurve = {
  oid: 'test-a2',
  bits: 512,
  p: 0x4531acd1fe0023c7550d267b6b2fee80922b14b2ffb90f04d4eb7c09b5d2d15df1d852741af4704a0458047e80e4546d35b8336fac224dd81664bbf528be6373n,
  a: 7n,
  b: 0x1cff0806a31116da29d8cfa54e57eb748bc5f377e49400fdd788b649eca1ac4361834013b2ad7322480a89ca58e0cf74bc9e540c2add6897fad0a3084f302adcn,
  q: 0x4531acd1fe0023c7550d267b6b2fee80922b14b2ffb90f04d4eb7c09b5d2d15da82f2d7ecb1dbac719905c5eecc423f1d86e25edbe23c595d644aaf187e6e6dfn,
  x: 0x24d19cc64572ee30f396bf6ebbfd7a6c5213b3b3d7057cc825f91093a68cd762fd60611262cd838dc6b60aa7eee804e28bc849977fac33b4b530f1b120248a9an,
  y: 0x2bb312a43bd2ce6e0d020613c857acddcfbf061e91e5f2c3f32447c259f39b2c83ab156d77f1496bf7eb3351e1ee4e43dc1a18b91b24640b6dbb92cb1add371en,
};
const A2 = {
  key: {
    curve: A2_CURVE,
    x: 0x115dc5bc96760c7b48598d8ab9e740d4c4a85a65be33c1815b5c320c854621dd5a515856d13314af69bc5b924c8b4ddff75c45415c1d9dd9dd33612cd530efe1n,
    y: 0x37c7c90cd40b0f5621dc3ac1b751cfa0e2634fa0503b3d52639f5d7fb72afd61ea199441d943ffe7f0c70a2759a3cdb84c114e1f9339fdf27f35eca93677beecn,
  } satisfies GostPublicKey,
  e: 0x3754f3cfacc9e0615c4f4a7c4d8dab531b09b6f9c170c533a71d147035b0c5917184ee536593f4414339976c647c5d5a407adedb1d560c4fc6777d2972075b8cn,
  r: 0x2f86fa60a081091a23dd795e1e3c689ee512a3c82ee0dcc2643c78eea8fcacd35492558486b20f1c9ec197c90699850260c93bcbcd9c5c3317e19344e173ae36n,
  s: 0x1081b394696ffe8e6585e7a9362d26b6325f56778aadbc081c0bfbe933d52ff5823ce288e8c4f362526080df7f70ce406a6eeb1f56919cb92a9853bde73e5b4an,
};

const cases = [
  ['А.1 (256)', A1],
  ['А.2 (512)', A2],
] as const;

describe('ГОСТ Р 34.10-2012: проверка подписи', () => {
  it.each(cases)('приложение %s — подпись верна', (_, t) => {
    const len = t.key.curve.bits / 8;
    expect(verifyGost(t.key, le(t.e, len), sigBytes(t.r, t.s, len))).toBe(true);
  });

  it.each(cases)('приложение %s — испорченные r, s, хеш не проходят', (_, t) => {
    const len = t.key.curve.bits / 8;
    const h = le(t.e, len);
    const q = t.key.curve.q;
    expect(verifyGost(t.key, h, sigBytes(t.r ^ 1n, t.s, len))).toBe(false);
    expect(verifyGost(t.key, h, sigBytes(t.r, t.s ^ 1n, len))).toBe(false);
    expect(verifyGost(t.key, h, sigBytes(0n, t.s, len))).toBe(false);
    expect(verifyGost(t.key, h, sigBytes(t.r, 0n, len))).toBe(false);
    expect(verifyGost(t.key, h, sigBytes(t.r, q, len))).toBe(false);
    expect(verifyGost(t.key, h, sigBytes(q, t.s, len))).toBe(false);
    expect(verifyGost(t.key, le(t.e ^ 1n, len), sigBytes(t.r, t.s, len))).toBe(false);
    // Порядок r ‖ s (не по RFC 4491) — неверно.
    expect(verifyGost(t.key, h, new Uint8Array([...be(t.r, len), ...be(t.s, len)]))).toBe(false);
    // Неверная длина подписи или хеша.
    expect(verifyGost(t.key, h, sigBytes(t.r, t.s, len).subarray(1))).toBe(false);
    expect(verifyGost(t.key, h.subarray(1), sigBytes(t.r, t.s, len))).toBe(false);
  });

  it('OpenSSL (движок gost, pkeyutl): raw-256a.bin над Стрибог-256 doc.pdf', () => {
    const hash = streebog(256, fx('gost', 'doc.pdf'));
    const sig = fx('gost', 'raw-256a.bin');
    expect(sig.length).toBe(64);
    expect(verifyGost(keyOf('user256a.pem'), hash, sig)).toBe(true);
    expect(verifyGost(keyOf('other256.pem'), hash, sig)).toBe(false);
    expect(verifyGost(keyOf('user256a.pem'), streebog(256, Buffer.from('x')), sig)).toBe(false);
  });

  it('OpenSSL (движок gost, pkeyutl): raw-512a.bin над Стрибог-512 doc.pdf', () => {
    const hash = streebog(512, fx('gost', 'doc.pdf'));
    const sig = fx('gost', 'raw-512a.bin');
    expect(sig.length).toBe(128);
    expect(verifyGost(keyOf('user512a.pem'), hash, sig)).toBe(true);
    const bad = Buffer.from(sig);
    bad[bad.length - 1] = bad[bad.length - 1]! ^ 1;
    expect(verifyGost(keyOf('user512a.pem'), hash, bad)).toBe(false);
  });
});

describe('ГОСТ Р 34.10-2012: наборы параметров', () => {
  const expected = [
    '1.2.643.7.1.2.1.1.1',
    '1.2.643.7.1.2.1.1.2',
    '1.2.643.7.1.2.1.1.3',
    '1.2.643.7.1.2.1.1.4',
    '1.2.643.2.2.35.1',
    '1.2.643.2.2.35.2',
    '1.2.643.2.2.35.3',
    '1.2.643.2.2.36.0',
    '1.2.643.2.2.36.1',
    '1.2.643.7.1.2.1.2.1',
    '1.2.643.7.1.2.1.2.2',
    '1.2.643.7.1.2.1.2.3',
  ];

  it('все наборы есть, OID и разрядность согласованы', () => {
    expect([...GOST_CURVES.keys()].sort()).toEqual([...expected].sort());
    for (const [oid, c] of GOST_CURVES) {
      expect(c.oid).toBe(oid);
      expect(c.bits).toBe(oid.startsWith('1.2.643.7.1.2.1.2.') ? 512 : 256);
      expect(c.p.toString(2).length).toBe(c.bits);
    }
  });

  it.each(expected)('%s: базовая точка лежит на кривой', (oid) => {
    const c = GOST_CURVES.get(oid)!;
    expect((c.y * c.y - (c.x ** 3n + c.a * c.x + c.b)) % c.p).toBe(0n);
  });

  it.each(expected)('%s: q·G = O (порядок базовой точки — q)', (oid) => {
    // Независимо от gost3410.ts: аффинные координаты, обратный — расширенным алгоритмом Евклида.
    const c = GOST_CURVES.get(oid)!;
    const m = (v: bigint) => ((v % c.p) + c.p) % c.p;
    const inv = (v: bigint) => {
      let [r0, r1, t0, t1] = [m(v), c.p, 1n, 0n];
      while (r1 !== 0n) {
        const k = r0 / r1;
        [r0, r1, t0, t1] = [r1, r0 - k * r1, t1, t0 - k * t1];
      }
      return m(t0);
    };
    type P = { x: bigint; y: bigint } | null; // null — бесконечно удаленная точка
    const add = (A: P, B: P): P => {
      if (!A) return B;
      if (!B) return A;
      if (A.x === B.x && m(A.y + B.y) === 0n) return null;
      const l =
        A.x === B.x ? m((3n * A.x * A.x + c.a) * inv(2n * A.y)) : m((B.y - A.y) * inv(B.x - A.x));
      const x = m(l * l - A.x - B.x);
      return { x, y: m(l * (A.x - x) - A.y) };
    };
    const mulP = (k: bigint, G: P): P => {
      let R: P = null;
      for (let i = k.toString(2).length - 1; i >= 0; i--) {
        R = add(R, R);
        if ((k >> BigInt(i)) & 1n) R = add(R, G);
      }
      return R;
    };
    const G = { x: c.x, y: c.y };
    expect(mulP(c.q - 1n, G)).toEqual({ x: c.x, y: m(-c.y) });
    expect(mulP(c.q, G)).toBeNull();
  });

  it('псевдонимы: TC26-256-B/C/D = CryptoPro A/B/C, XchA = A, XchB = C', () => {
    const same = (a: string, b: string) => {
      const { oid: _a, ...x } = GOST_CURVES.get(a)!;
      const { oid: _b, ...y } = GOST_CURVES.get(b)!;
      expect(x).toEqual(y);
    };
    same('1.2.643.7.1.2.1.1.2', '1.2.643.2.2.35.1');
    same('1.2.643.7.1.2.1.1.3', '1.2.643.2.2.35.2');
    same('1.2.643.7.1.2.1.1.4', '1.2.643.2.2.35.3');
    same('1.2.643.2.2.36.0', '1.2.643.2.2.35.1');
    same('1.2.643.2.2.36.1', '1.2.643.2.2.35.3');
  });
});

describe('gostPublicKeyFromSpki', () => {
  it.each([
    ['user256a.pem', '1.2.643.7.1.2.1.1.1', 256],
    ['user256cp.pem', '1.2.643.2.2.35.1', 256],
    ['user512a.pem', '1.2.643.7.1.2.1.2.1', 512],
  ])('%s → набор %s', (n, oid, bits) => {
    const key = gostPublicKeyFromSpki(spkiOf('gost', n));
    expect(key?.curve.oid).toBe(oid);
    expect(key?.curve.bits).toBe(bits);
  });

  it('RSA-сертификат — null', () => {
    expect(gostPublicKeyFromSpki(spkiOf('sign', 'ca.pem'))).toBeNull();
  });

  it('точка вне кривой (y + 1) — null', () => {
    const spki = pkijs.Certificate.fromBER(certDer('gost', 'user256a.pem')).subjectPublicKeyInfo;
    const der = new Uint8Array(spki.toSchema().toBER());
    // subjectPublicKey: BIT STRING { OCTET STRING (64) x ‖ y little-endian } — в конце DER.
    // Младший байт y — первый из последних 32 байт; +1 без переноса, если он не 0xff.
    const at = der.length - 32;
    expect(der[at]).not.toBe(0xff);
    der[at] = der[at]! + 1;
    expect(gostPublicKeyFromSpki(der)).toBeNull();
  });

  it('мусор вместо DER — null', () => {
    expect(gostPublicKeyFromSpki(new Uint8Array([1, 2, 3]))).toBeNull();
  });
});
