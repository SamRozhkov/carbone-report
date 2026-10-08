import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reportRunFiles, reportRuns } from '../src/db/schema';
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
    id,
    templateId: null,
    templateName: 'x',
    templateVersion: 1,
    userId,
    params: {},
    outputFormat: 'pdf',
    status: 'ok',
    filePath,
    durationMs: 1,
    createdAt: new Date(Date.now() - daysAgo * 86_400_000),
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
  it('сбой удаления одного файла не прерывает пакет; запись помечена, файл остаётся сиротой', async () => {
    const bad = await run(50);
    const good = await run(50);
    const orig = t.deps.storage.remove.bind(t.deps.storage);
    t.deps.storage.remove = async (p: string) => {
      if (p === bad.filePath) throw new Error('disk');
      return orig(p);
    };
    try {
      const warns: unknown[] = [];
      expect(await cleanupOldReports(t.deps, new Date(), { warn: (o) => void warns.push(o) })).toBe(
        1,
      );
      expect(warns).toHaveLength(1);
    } finally {
      t.deps.storage.remove = orig;
    }
    const [g] = await t.deps.db.select().from(reportRuns).where(eq(reportRuns.id, good.id));
    const [b] = await t.deps.db.select().from(reportRuns).where(eq(reportRuns.id, bad.id));
    expect(g!.fileDeleted).toBe(true);
    // Отметка ставится до удаления: строка не указывает на файл, а сирота безвредна.
    expect(b!.fileDeleted).toBe(true);
    expect(await t.deps.storage.exists(bad.filePath)).toBe(true);
    expect(await cleanupOldReports(t.deps)).toBe(0); // повторно не трогается
  });
  it('повторный запуск ничего не делает', async () => {
    expect(await cleanupOldReports(t.deps)).toBe(0);
  });
  it('скачивание удалённого файла → 410', async () => {
    const old = await run(40);
    await cleanupOldReports(t.deps);
    const cookie = (await loginAs(t, 'admin')).cookie;
    const r = await t.app.inject({
      method: 'GET',
      url: `/api/runs/${old.id}/file`,
      headers: { cookie },
    });
    expect(r.statusCode).toBe(410);
  });

  it('запуск со снимком: удаляется весь каталог и строки report_run_files; скачивание → 410', async () => {
    const snapshotRun = async (daysAgo: number) => {
      const id = crypto.randomUUID();
      const dir = `reports/${id}`;
      await t.deps.storage.write(`${dir}/data.json`, Buffer.from('{}'));
      await t.deps.storage.write(`${dir}/template.docx`, Buffer.from('tpl'));
      await t.deps.storage.write(`${dir}/out.pdf`, Buffer.from('pdf'));
      await t.deps.db.insert(reportRuns).values({
        id,
        templateId: null,
        templateName: 'x',
        templateVersion: 1,
        userId,
        params: {},
        status: 'ok',
        snapshot: true,
        filePath: `${dir}/template.docx`,
        durationMs: 1,
        createdAt: new Date(Date.now() - daysAgo * 86_400_000),
      });
      await t.deps.db
        .insert(reportRunFiles)
        .values({ runId: id, format: 'pdf', filePath: `${dir}/out.pdf` });
      return { id, dir };
    };
    const old = await snapshotRun(45);
    const fresh = await snapshotRun(2);
    expect(await cleanupOldReports(t.deps)).toBe(1);
    expect(await t.deps.storage.exists(old.dir)).toBe(false);
    expect(await t.deps.storage.exists(`${fresh.dir}/out.pdf`)).toBe(true);
    const filesOf = (id: string) =>
      t.deps.db.select().from(reportRunFiles).where(eq(reportRunFiles.runId, id));
    expect(await filesOf(old.id)).toHaveLength(0);
    expect(await filesOf(fresh.id)).toHaveLength(1);
    const [row] = await t.deps.db.select().from(reportRuns).where(eq(reportRuns.id, old.id));
    expect(row!.fileDeleted).toBe(true);
    const cookie = (await loginAs(t, 'admin')).cookie;
    const r = await t.app.inject({
      method: 'GET',
      url: `/api/runs/${old.id}/file?format=docx`,
      headers: { cookie },
    });
    expect(r.statusCode).toBe(410);
    expect(r.json().error.message).toBe('файл удалён — сформируйте отчёт заново');
  });
});
