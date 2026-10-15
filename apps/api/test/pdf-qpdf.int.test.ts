import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CarboneRenderer } from '../src/deps';
import { createQpdfProtector, qpdfVersion } from '../src/modules/pdf/protect';
import { makePdf, pageTexts } from '../src/modules/pdf/test-pdf';
import { createTemplate, createTestApp, loginAs, type TestApp } from './helpers';

const version = await qpdfVersion();
const carbone: CarboneRenderer = {
  async render() {
    return Buffer.from(await makePdf([{ label: 'REPORT' }]));
  },
};

if (process.env.REQUIRE_QPDF === '1') {
  it('REQUIRE_QPDF=1: qpdf установлен', () => {
    expect(version).not.toBeNull();
  });
}

describe.skipIf(version === null)('отчёт с паролем — настоящий qpdf (§37.2)', () => {
  let t: TestApp;
  let admin: string;
  beforeAll(async () => {
    t = await createTestApp({ carbone, pdfProtect: createQpdfProtector({ maxConcurrent: 1 }) });
    admin = (await loginAs(t, 'admin')).cookie;
  });
  afterAll(() => t?.close());

  it('без пароля не открывается, с паролем — текст отчёта', async () => {
    const ds = await t.app.inject({
      method: 'POST',
      url: '/api/datasources',
      headers: { cookie: admin },
      payload: {
        name: 'src',
        host: 'localhost',
        port: 5432,
        database: 'x',
        username: 'x',
        password: 'x',
        sslMode: 'disable',
      },
    });
    const id = await createTemplate(t, admin, ds.json().id);
    await t.app.inject({
      method: 'PUT',
      url: `/api/templates/${id}/pdf-options`,
      headers: { cookie: admin },
      payload: { protection: { noPrint: true }, password: 'секрет1' },
    });
    const run = await t.app.inject({
      method: 'POST',
      url: `/api/reports/${id}/render`,
      headers: { cookie: admin },
      payload: { params: {} },
    });
    expect(run.statusCode).toBe(201);
    const file = await t.app.inject({
      url: `/api/runs/${run.json().runId}/file?format=pdf`,
      headers: { cookie: admin },
    });
    await expect(pageTexts(file.rawPayload)).rejects.toThrow(/password/i);
    expect((await pageTexts(file.rawPayload, 'секрет1'))[0]).toContain('REPORT');
  });
});
