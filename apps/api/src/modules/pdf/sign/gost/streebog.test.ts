import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Streebog, streebog } from './streebog';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
// RFC 6986 записывает сообщения и хеши числами (младший байт справа), OpenSSL и CMS — байтами
// в обратном порядке: сравниваем с перевернутыми значениями RFC.
const rev = (h: string) => Buffer.from(h, 'hex').reverse().toString('hex');
const fx = (n: string) =>
  readFileSync(new URL(`../../../../../test/fixtures/gost/${n}`, import.meta.url));
const dgstHex = (n: string) => fx(n).toString().trim().split(/\s+/).pop();

// RFC 6986 §10.1, пример 1: M1 = 0x3231…3130 (63 байта, записан как число — младший байт справа).
const M1 = Buffer.from(
  '323130393837363534333231303938373635343332313039383736353433323130393837363534333231303938373635343332313039383736353433323130',
  'hex',
).reverse();
// RFC 6986 §10.2, пример 2: M2 (72 байта) — «Се ветри, Стрибожи внуци, …» в CP1251, тоже числом.
const M2 = Buffer.from(
  'fbe2e5f0eee3c820fbeafaebef20fffbf0e1e0f0f520e0ed20e8ece0ebe5f0f2f120fff0eeec20f120faf2fee5e2202ce8f6f3ede220e8e6eee1e8f0f2d1202ce8f0f2e5e220e5d1',
  'hex',
).reverse();

describe('Стрибог', () => {
  it('RFC 6986 пример 1, 512 и 256', () => {
    expect(hex(streebog(512, M1))).toBe(
      rev(
        '486f64c1917879417fef082b3381a4e211c324f074654c38823a7b76f830ad00fa1fbae42b1285c0352f227524bc9ab16254288dd6863dccd5b9f54a1ad0541b',
      ),
    );
    expect(hex(streebog(256, M1))).toBe(
      rev('00557be5e584fd52a449b16b0251d05d27f94ab76cbaa6da890b59d8ef1e159d'),
    );
  });

  it('RFC 6986 пример 2 (72 байта, «Се ветри…» в CP1251) — 512 и 256', () => {
    expect(M2.length).toBe(72);
    expect(new TextDecoder('windows-1251').decode(M2)).toBe(
      'Се ветри, Стрибожи внуци, веютъ с моря стрелами на храбрыя плъкы Игоревы',
    );
    expect(hex(streebog(512, M2))).toBe(
      rev(
        '28fbc9bada033b1460642bdcddb90c3fb3e56c497ccd0f62b8a2ad4935e85f037613966de4ee00531ae60f3b5a47f8dae06915d5f2f194996fcabf2622e6881e',
      ),
    );
    expect(hex(streebog(256, M2))).toBe(
      rev('508f7e553c06501d749a66fc28c6cac0b005746d97537fa85d9e40904efed29d'),
    );
  });

  it('совпадает с OpenSSL на doc.pdf', () => {
    expect(hex(streebog(256, fx('doc.pdf')))).toBe(dgstHex('doc.pdf.streebog256.hex'));
    expect(hex(streebog(512, fx('doc.pdf')))).toBe(dgstHex('doc.pdf.streebog512.hex'));
  });

  it('потоковый хеш частями = хеш целиком (границы 1, 63, 64, 65 байт)', () => {
    const data = fx('doc.pdf');
    for (const bits of [256, 512] as const) {
      for (const step of [1, 63, 64, 65, 4096]) {
        const s = new Streebog(bits);
        for (let i = 0; i < data.length; i += step) s.update(data.subarray(i, i + step));
        expect(hex(s.digest())).toBe(hex(streebog(bits, data)));
      }
    }
  });

  it('пустое сообщение', () => {
    // echo -n | openssl dgst -md_gost12_256 / -md_gost12_512 (rnix/openssl-gost).
    expect(hex(streebog(256, new Uint8Array(0)))).toBe(
      '3f539a213e97c802cc229d474c6aa32a825a360b2a933a949fd925208d9ce1bb',
    );
    expect(hex(streebog(512, new Uint8Array(0)))).toBe(
      '8e945da209aa869f0455928529bcae4679e9873ab707b55315f56ceb98bef0a7362f715528356ee83cda5f2aac4c6ad2ba3a715c1bcd81cb8e9f90bf4c1c1a8a',
    );
  });

  it('10 МБ быстрее 2 с', () => {
    const data = new Uint8Array(10 * 1024 * 1024).map((_, i) => i * 31);
    const t = performance.now();
    streebog(256, data);
    expect(performance.now() - t).toBeLessThan(2000);
  });
});
