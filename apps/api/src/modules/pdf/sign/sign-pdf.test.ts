import * as pkijs from 'pkijs';
import { afterEach, describe, expect, it } from 'vitest';
import type { SignPrepareJob } from './prepare';
import { makePdf } from '../test-pdf';
import { OID } from './cms';
import { fixture, FIXTURE_PASSWORD } from './fixtures';
import { readP12 } from './p12';
import { inProcessSignPreparer } from './preparer';
import { P12Signer, type CmsSigner } from './signer';
import { signPdf, stampLines } from './sign-pdf';
import { createTsaClient } from './tsa';
import { extractSignature, opensslVerify } from './test-verify';
import { startTestTsa, type TestTsa } from './test-tsa';

const ab = (b: Uint8Array) => new Uint8Array(b).slice().buffer;
const NOW = new Date('2026-10-19T11:32:00.000Z');
let tsa: TestTsa | undefined;
afterEach(async () => {
  await tsa?.close();
  tsa = undefined;
});

const sign = async (signer: CmsSigner, pdf?: Uint8Array) =>
  signPdf(Buffer.from(pdf ?? (await makePdf([{ label: 'a' }, { label: 'b' }]))), signer, {
    position: 'bottom-right',
    now: NOW,
    timeZone: 'Europe/Moscow',
    locale: 'ru',
    deadline: Date.now() + 30_000,
    prepare: inProcessSignPreparer,
  });

const signerOf = (name: string, tsaUrl?: string) =>
  new P12Signer(
    readP12(fixture(name), FIXTURE_PASSWORD),
    tsaUrl ? createTsaClient(tsaUrl, 5000) : null,
  );

const signedData = (pdf: Buffer) =>
  new pkijs.SignedData({
    schema: pkijs.ContentInfo.fromBER(ab(extractSignature(pdf).cms)).content,
  });

describe('signPdf (§39.4)', () => {
  it.each(['rsa.p12', 'ec.p12', 'ec384.p12'])(
    '%s: PDF подписан, openssl cms -verify проходит',
    async (name) => {
      await opensslVerify(await sign(signerOf(name)));
    },
  );

  it('цепочка из трёх и метка времени помещаются, подпись проверяется', async () => {
    tsa = await startTestTsa();
    const pdf = await sign(signerOf('chain3.p12', tsa.url));
    await opensslVerify(pdf);
    const si = signedData(pdf).signerInfos[0]!;
    expect(signedData(pdf).certificates).toHaveLength(3);
    expect(si.unsignedAttrs!.attributes.map((a) => a.type)).toEqual([OID.timeStampToken]);
  });

  it('без службы меток — без неподписанных атрибутов', async () => {
    const si = signedData(await sign(signerOf('rsa.p12'))).signerInfos[0]!;
    expect(si.unsignedAttrs).toBeUndefined();
  });

  it('запаса мало — ошибка, а не обрезанная подпись', async () => {
    const real = signerOf('rsa.p12');
    const tiny: CmsSigner = {
      info: real.info,
      digestAlg: real.digestAlg,
      reserveBytes: 100,
      createCms: (d, dl) => real.createCms(d, dl),
    };
    await expect(sign(tiny)).rejects.toThrow('CMS не помещается в /Contents');
  });

  it('служба меток отказала — подпись не собрана (502)', async () => {
    tsa = await startTestTsa('reject');
    await expect(sign(signerOf('rsa.p12', tsa.url))).rejects.toMatchObject({
      code: 'TSA_UNAVAILABLE',
      status: 502,
    });
  });

  it('срок уже истёк — 504', async () => {
    const pdf = Buffer.from(await makePdf([{ label: 'a' }]));
    await expect(
      signPdf(pdf, signerOf('rsa.p12'), {
        position: 'bottom-right',
        now: NOW,
        timeZone: 'Europe/Moscow',
        locale: 'ru',
        deadline: Date.now() - 1,
        prepare: inProcessSignPreparer,
      }),
    ).rejects.toMatchObject({ code: 'TIMEOUT', status: 504 });
  });
});

describe('stampLines (§39.5)', () => {
  it('строки и время в часовом поясе', () => {
    const info = readP12(fixture('rsa.p12'), FIXTURE_PASSWORD).info;
    const lines = stampLines(
      { ...info, notBefore: '2026-01-01T00:00:00.000Z', notAfter: '2027-01-01T00:00:00.000Z' },
      NOW,
      'Europe/Moscow',
      'ru',
    );
    expect(lines).toEqual([
      'ДОКУМЕНТ ПОДПИСАН ЭЛЕКТРОННОЙ ПОДПИСЬЮ',
      'Сертификат: 1001',
      'Владелец: Иванов Иван Иванович (rsa)',
      'Действителен: с 01.01.2026 по 01.01.2027',
      'Подписан: 19.10.2026 14:32',
    ]);
  });
});

const CERT = () => ({
  ...readP12(fixture('rsa.p12'), FIXTURE_PASSWORD).info,
  notBefore: '2026-01-01T00:00:00.000Z',
  notAfter: '2027-01-01T00:00:00.000Z',
});

describe('stampLines: язык отчёта (§45.4)', () => {
  it('en: строки каталога, дата MM/DD/YYYY, время 24 ч', () => {
    expect(stampLines(CERT(), NOW, 'Europe/Moscow', 'en')).toEqual([
      'DOCUMENT SIGNED WITH AN ELECTRONIC SIGNATURE',
      'Certificate: 1001',
      'Owner: Иванов Иван Иванович (rsa)',
      'Valid: from 01/01/2026 to 01/01/2027',
      'Signed: 10/19/2026 14:32',
    ]);
  });

  it('de: дата DD.MM.YYYY', () => {
    expect(stampLines(CERT(), NOW, 'Europe/Moscow', 'de')).toEqual([
      'DOKUMENT MIT ELEKTRONISCHER SIGNATUR SIGNIERT',
      'Zertifikat: 1001',
      'Eigentümer: Иванов Иван Иванович (rsa)',
      'Gültig: vom 01.01.2026 bis 01.01.2027',
      'Signiert: 19.10.2026 14:32',
    ]);
  });

  it('zh-CN: строки каталога, дата языка', () => {
    expect(stampLines(CERT(), NOW, 'Europe/Moscow', 'zh-CN')).toEqual([
      '文档已使用电子签名签署',
      '证书：1001',
      '所有者：Иванов Иван Иванович (rsa)',
      '有效期：2026/01/01 至 2027/01/01',
      '签署时间：2026/10/19 14:32',
    ]);
  });

  it('значения сертификата не интерпретируются i18next', () => {
    const lines = stampLines(
      { ...CERT(), subjectCn: '{{serial}} $t(report:stamp.title)' },
      NOW,
      'Europe/Moscow',
      'en',
    );
    expect(lines[2]).toBe('Owner: {{serial}} $t(report:stamp.title)');
  });
});

/** Строки штампа до 2.14.0 — дословная копия прежней реализации для сверки ru. */
function legacyStampLines(
  info: ReturnType<typeof CERT>,
  now: Date,
  timeZone: string,
): SignPrepareJob['lines'] {
  const date = new Intl.DateTimeFormat('ru-RU', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
  const time = new Intl.DateTimeFormat('ru-RU', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  return [
    'ДОКУМЕНТ ПОДПИСАН ЭЛЕКТРОННОЙ ПОДПИСЬЮ',
    `Сертификат: ${info.serial}`,
    `Владелец: ${info.subjectCn}`,
    `Действителен: с ${date.format(new Date(info.notBefore))} по ${date.format(new Date(info.notAfter))}`,
    `Подписан: ${date.format(now)} ${time.format(now)}`,
  ];
}

describe('штамп ru не изменился (§45.4)', () => {
  it('подготовленный PDF .p12 на ru побайтно совпадает с прежним путём', async () => {
    const pdf = Buffer.from(await makePdf([{ label: 'a' }, { label: 'b' }]));
    const real = signerOf('rsa.p12');
    const signer: CmsSigner = {
      info: CERT(),
      digestAlg: real.digestAlg,
      reserveBytes: real.reserveBytes,
      createCms: (d, dl) => real.createCms(d, dl),
    };
    let prepared: Buffer | undefined;
    await signPdf(pdf, signer, {
      position: 'bottom-right',
      now: NOW,
      timeZone: 'Europe/Moscow',
      locale: 'ru',
      deadline: Date.now() + 30_000,
      prepare: async (p, job, ms) => {
        prepared = Buffer.from(await inProcessSignPreparer(p, job, ms));
        return Buffer.from(prepared);
      },
    });
    const legacy = await inProcessSignPreparer(
      pdf,
      {
        position: 'bottom-right',
        lines: legacyStampLines(CERT(), NOW, 'Europe/Moscow'),
        contentsBytes: real.reserveBytes,
        signedAt: NOW.toISOString(),
      },
      30_000,
    );
    expect(prepared).toBeDefined();
    // Побайтно: тот же текст штампа, те же шрифты и то же положение.
    expect(prepared!.equals(legacy)).toBe(true);
  });
});
