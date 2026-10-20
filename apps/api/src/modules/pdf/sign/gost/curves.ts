// Наборы параметров эллиптических кривых ГОСТ Р 34.10-2012 (короткая форма Вейерштрасса
// y² = x³ + ax + b mod p, базовая точка P = (x, y) порядка q).
// Значения — дословно: TC26 — RFC 7836, приложение A (для скрученных кривых Эдвардса 256-A и
// 512-C — приведенные там же эквивалентные параметры Вейерштрасса a, b, x, y); CryptoPro —
// RFC 4357 §11.4. TC26-256-B/C/D совпадают с CryptoPro-A/B/C (Р 1323565.1.024-2019),
// XchA — с CryptoPro-A, XchB — с CryptoPro-C (RFC 4357 §11.4).

export interface GostCurve {
  oid: string;
  bits: 256 | 512;
  p: bigint;
  a: bigint;
  b: bigint;
  q: bigint;
  x: bigint;
  y: bigint;
}

type Params = Omit<GostCurve, 'oid'>;

// RFC 7836 A.2: id-tc26-gost-3410-2012-256-paramSetA (скрученная кривая Эдвардса, m = 4q).
const TC26_256_A: Params = {
  bits: 256,
  p: 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffd97n,
  a: 0xc2173f1513981673af4892c23035a27ce25e2013bf95aa33b22c656f277e7335n,
  b: 0x295f9bae7428ed9ccc20e7c359a9d41a22fccd9108e17bf7ba9337a6f8ae9513n,
  q: 0x400000000000000000000000000000000fd8cddfc87b6635c115af556c360c67n,
  x: 0x91e38443a5e82c0d880923425712b2bb658b9196932e02c78b2582fe742daa28n,
  y: 0x32879423ab1a0375895786c4bb46e9565fde0b5344766740af268adb32322e5cn,
};

// RFC 4357 §11.4: id-GostR3410-2001-CryptoPro-A-ParamSet.
const CRYPTOPRO_A: Params = {
  bits: 256,
  p: 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffd97n,
  a: 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffd94n,
  b: 0xa6n,
  q: 0xffffffffffffffffffffffffffffffff6c611070995ad10045841b09b761b893n,
  x: 0x1n,
  y: 0x8d91e471e0989cda27df505a453f2b7635294f2ddf23e3b122acc99c9e9f1e14n,
};

// RFC 4357 §11.4: id-GostR3410-2001-CryptoPro-B-ParamSet.
const CRYPTOPRO_B: Params = {
  bits: 256,
  p: 0x8000000000000000000000000000000000000000000000000000000000000c99n,
  a: 0x8000000000000000000000000000000000000000000000000000000000000c96n,
  b: 0x3e1af419a269a5f866a7d3c25c3df80ae979259373ff2b182f49d4ce7e1bbc8bn,
  q: 0x800000000000000000000000000000015f700cfff1a624e5e497161bcc8a198fn,
  x: 0x1n,
  y: 0x3fa8124359f96680b83d1c3eb2c070e5c545c9858d03ecfb744bf8d717717efcn,
};

// RFC 4357 §11.4: id-GostR3410-2001-CryptoPro-C-ParamSet.
const CRYPTOPRO_C: Params = {
  bits: 256,
  p: 0x9b9f605f5a858107ab1ec85e6b41c8aacf846e86789051d37998f7b9022d759bn,
  a: 0x9b9f605f5a858107ab1ec85e6b41c8aacf846e86789051d37998f7b9022d7598n,
  b: 0x805an,
  q: 0x9b9f605f5a858107ab1ec85e6b41c8aa582ca3511eddfb74f02f3a6598980bb9n,
  x: 0x0n,
  y: 0x41ece55743711a8c3cbf3783cd08c0ee4d4dc440d4641a8f366e550dfdb3bb67n,
};

// RFC 7836 A.1: id-tc26-gost-3410-12-512-paramSetA.
const TC26_512_A: Params = {
  bits: 512,
  p: 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffdc7n,
  a: 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffdc4n,
  b: 0xe8c2505dedfc86ddc1bd0b2b6667f1da34b82574761cb0e879bd081cfd0b6265ee3cb090f30d27614cb4574010da90dd862ef9d4ebee4761503190785a71c760n,
  q: 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff27e69532f48d89116ff22b8d4e0560609b4b38abfad2b85dcacdb1411f10b275n,
  x: 0x3n,
  y: 0x7503cfe87a836ae3a61b8816e25450e6ce5e1c93acf1abc1778064fdcbefa921df1626be4fd036e93d75e6a50e3a41e98028fe5fc235f5b889a589cb5215f2a4n,
};

// RFC 7836 A.1: id-tc26-gost-3410-12-512-paramSetB.
const TC26_512_B: Params = {
  bits: 512,
  p: 0x8000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006fn,
  a: 0x8000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000006cn,
  b: 0x687d1b459dc841457e3e06cf6f5e2517b97c7d614af138bcbf85dc806c4b289f3e965d2db1416d217f8b276fad1ab69c50f78bee1fa3106efb8ccbc7c5140116n,
  q: 0x800000000000000000000000000000000000000000000000000000000000000149a1ec142565a545acfdb77bd9d40cfa8b996712101bea0ec6346c54374f25bdn,
  x: 0x2n,
  y: 0x1a8f7eda389b094c2c071e3647a8940f3c123b697578c213be6dd9e6c8ec7335dcb228fd1edf4a39152cbcaaf8c0398828041055f94ceeec7e21340780fe41bdn,
};

// RFC 7836 A.2: id-tc26-gost-3410-2012-512-paramSetC (скрученная кривая Эдвардса, m = 4q).
const TC26_512_C: Params = {
  bits: 512,
  p: 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffdc7n,
  a: 0xdc9203e514a721875485a529d2c722fb187bc8980eb866644de41c68e143064546e861c0e2c9edd92ade71f46fcf50ff2ad97f951fda9f2a2eb6546f39689bd3n,
  b: 0xb4c4ee28cebc6c2c8ac12952cf37f16ac7efb6a9f69f4b57ffda2e4f0de5ade038cbc2fff719d2c18de0284b8bfef3b52b8cc7a5f5bf0a3c8d2319a5312557e1n,
  q: 0x3fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc98cdba46506ab004c33a9ff5147502cc8eda9e7a769a12694623cef47f023edn,
  x: 0xe2e31edfc23de7bdebe241ce593ef5de2295b7a9cbaef021d385f7074cea043aa27272a7ae602bf2a7b9033db9ed3610c6fb85487eae97aac5bc7928c1950148n,
  y: 0xf5ce40d95b5eb899abbccff5911cb8577939804d6527378b8c108c3d2090ff9be18e2d33e3021ed2ef32d85822423b6304f726aa854bae07d0396e9a9addc40fn,
};

const table: [string, Params][] = [
  ['1.2.643.7.1.2.1.1.1', TC26_256_A], // id-tc26-gost-3410-2012-256-paramSetA
  ['1.2.643.7.1.2.1.1.2', CRYPTOPRO_A], // id-tc26-gost-3410-2012-256-paramSetB
  ['1.2.643.7.1.2.1.1.3', CRYPTOPRO_B], // id-tc26-gost-3410-2012-256-paramSetC
  ['1.2.643.7.1.2.1.1.4', CRYPTOPRO_C], // id-tc26-gost-3410-2012-256-paramSetD
  ['1.2.643.2.2.35.1', CRYPTOPRO_A], // id-GostR3410-2001-CryptoPro-A-ParamSet
  ['1.2.643.2.2.35.2', CRYPTOPRO_B], // id-GostR3410-2001-CryptoPro-B-ParamSet
  ['1.2.643.2.2.35.3', CRYPTOPRO_C], // id-GostR3410-2001-CryptoPro-C-ParamSet
  ['1.2.643.2.2.36.0', CRYPTOPRO_A], // id-GostR3410-2001-CryptoPro-XchA-ParamSet
  ['1.2.643.2.2.36.1', CRYPTOPRO_C], // id-GostR3410-2001-CryptoPro-XchB-ParamSet
  ['1.2.643.7.1.2.1.2.1', TC26_512_A], // id-tc26-gost-3410-12-512-paramSetA
  ['1.2.643.7.1.2.1.2.2', TC26_512_B], // id-tc26-gost-3410-12-512-paramSetB
  ['1.2.643.7.1.2.1.2.3', TC26_512_C], // id-tc26-gost-3410-2012-512-paramSetC
];

/** Наборы параметров ГОСТ Р 34.10-2012; ключ — OID набора. */
export const GOST_CURVES: ReadonlyMap<string, GostCurve> = new Map(
  table.map(([oid, params]) => [oid, Object.freeze({ oid, ...params })]),
);
