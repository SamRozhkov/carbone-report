import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '../../../lib/errors';
import { createTsaClient } from './tsa';
import { startTestTsa, type TestTsa } from './test-tsa';

const imprint = createHash('sha256').update('подпись').digest();
let tsa: TestTsa | undefined;
afterEach(async () => {
  await tsa?.close();
  tsa = undefined;
});

async function expectError(p: Promise<unknown>, code: string, status: number) {
  await expect(p).rejects.toBeInstanceOf(AppError);
  await expect(p).rejects.toMatchObject({ code, status });
}

describe('createTsaClient (§39.4, RFC 3161)', () => {
  it('метка получена и проверена', async () => {
    tsa = await startTestTsa();
    const token = await createTsaClient(tsa.url, 5000)(imprint, Date.now() + 10_000);
    expect(token.length).toBeGreaterThan(500);
    expect(tsa.requests).toBe(1);
  });

  it.each(['reject', 'wrong-nonce', 'wrong-imprint', 'wrong-hash-alg', 'garbage'] as const)(
    '%s — 502 TSA_UNAVAILABLE',
    async (mode) => {
      tsa = await startTestTsa(mode);
      await expectError(
        createTsaClient(tsa.url, 5000)(imprint, Date.now() + 10_000),
        'TSA_UNAVAILABLE',
        502,
      );
    },
  );

  it('служба молчит дольше SIGN_TSA_TIMEOUT_MS — 502', async () => {
    tsa = await startTestTsa('hang');
    await expectError(
      createTsaClient(tsa.url, 200)(imprint, Date.now() + 10_000),
      'TSA_UNAVAILABLE',
      502,
    );
  });

  it('служба молчит, а срок отчёта кончается раньше — 504 TIMEOUT (R12)', async () => {
    tsa = await startTestTsa('hang');
    await expectError(createTsaClient(tsa.url, 10_000)(imprint, Date.now() + 200), 'TIMEOUT', 504);
  });

  it('служба недоступна — 502', async () => {
    await expectError(
      createTsaClient('http://127.0.0.1:9/tsa', 1000)(imprint, Date.now() + 5000),
      'TSA_UNAVAILABLE',
      502,
    );
  });
});
