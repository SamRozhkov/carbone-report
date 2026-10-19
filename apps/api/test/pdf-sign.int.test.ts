import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { postprocessPdf } from '../src/modules/pdf/postprocess';
import { fixture, FIXTURE_PASSWORD } from '../src/modules/pdf/sign/fixtures';
import { readP12 } from '../src/modules/pdf/sign/p12';
import { inProcessSignPreparer } from '../src/modules/pdf/sign/preparer';
import { signPdf } from '../src/modules/pdf/sign/sign-pdf';
import { P12Signer } from '../src/modules/pdf/sign/signer';
import { startTestTsa, type TestTsa } from '../src/modules/pdf/sign/test-tsa';
import { createTsaClient } from '../src/modules/pdf/sign/tsa';
import { makePdf } from '../src/modules/pdf/test-pdf';
import { pyhankoAvailable, pyhankoValidate } from './pyhanko';

const enabled = await pyhankoAvailable();
let tsa: TestTsa;
beforeAll(async () => {
  if (enabled) tsa = await startTestTsa();
});
afterAll(async () => tsa?.close());

async function signed(name: string, withTsa: boolean) {
  const base = await postprocessPdf(
    await makePdf([{ label: 'Первая' }, { label: 'Последняя', rotate: 90 }]),
    {
      pdfa: false,
      watermark: { text: 'ОБРАЗЕЦ', opacity: 20, color: 'gray', angle: 'diagonal' },
      pageNumbers: {
        format: 'Стр. {page} из {pages}',
        position: 'bottom-center',
        skipFirst: false,
      },
      metadata: { title: 'Отчёт', author: '', subject: '', keywords: '' },
      attachments: [],
      now: new Date().toISOString(),
    },
  );
  const signer = new P12Signer(
    readP12(fixture(name), FIXTURE_PASSWORD),
    withTsa ? createTsaClient(tsa.url, 5000) : null,
  );
  return signPdf(Buffer.from(base), signer, {
    position: 'bottom-right',
    now: new Date(),
    timeZone: 'Europe/Moscow',
    deadline: Date.now() + 60_000,
    prepare: inProcessSignPreparer,
  });
}

describe.skipIf(!enabled)('подпись PDF проверяется pyHanko (§39.7)', () => {
  it.each(['rsa.p12', 'ec.p12', 'ec384.p12', 'chain3.p12'])(
    '%s без метки — INTACT:TRUSTED',
    async (name) => {
      const out = await pyhankoValidate(await signed(name, false));
      expect(out).toContain('INTACT:TRUSTED');
    },
  );

  it('с меткой времени — метка тоже действительна', async () => {
    const out = await pyhankoValidate(await signed('rsa.p12', true));
    expect(out).toContain('INTACT:TRUSTED');
    expect(out).toContain('TIMESTAMP_TOKEN<INTACT:TRUSTED>');
  });
});
