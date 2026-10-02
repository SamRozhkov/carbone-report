import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reportRuns } from '../src/db/schema';
import { cleanupOldReports } from '../src/modules/reports/cleanup';
import { createTestApp, loginAs, type TestApp } from './helpers';

let t: TestApp;
let userId: string;
beforeAll(async () => {
  t = await createTestApp();
  userId = (await loginAs(t, 'user')).user.id;
});
afterAll(() => t.close());

async function run(daysAgo: number) {
  const id = crypto.randomUUID();
  const filePath = `reports/${id}.pdf`;
  await t.deps.storage.write(filePath, Buffer.from('pdf'));
  await t.deps.db.insert(reportRuns).values({
    id, templateId: null, templateName: 'x', templateVersion: 1, userId, params: {}, outputFormat: 'pdf',
    status: 'ok', filePath, durationMs: 1, createdAt: new Date(Date.now() - daysAgo * 86_400_000),
  });
  return { id, filePath };
}

describe('cleanupOldReports', () => {
  it('удаляет файлы старше срока хранения, запись помечает file_deleted', async () => {
    const old = await run(31);
    const fresh = await run(1);
    expect(await cleanupOldReports(t.deps)).toBe(1);
    expect(await t.deps.storage.exists(old.filePath)).toBe(false);
    expect(await t.deps.storage.exists(fresh.filePath)).toBe(true);
    const [row] = await t.deps.db.select().from(reportRuns).where(eq(reportRuns.id, old.id));
    expect(row!.fileDeleted).toBe(true);
  });
  it('повторный запуск ничего не делает', async () => {
    expect(await cleanupOldReports(t.deps)).toBe(0);
  });
  it('скачивание удалённого файла → 410', async () => {
    const old = await run(40);
    await cleanupOldReports(t.deps);
    const cookie = (await loginAs(t, 'admin')).cookie;
    const r = await t.app.inject({ method: 'GET', url: `/api/runs/${old.id}/file`, headers: { cookie } });
    expect(r.statusCode).toBe(410);
  });
});
