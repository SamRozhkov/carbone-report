import { posix } from 'node:path';
import { outputFormatsFor, TemplateExt, type OutputFormat } from '@carbone-reports/shared';
import { and, eq, sql } from 'drizzle-orm';
import { reportRunFiles, reportRuns, type RunRow } from '../../db/schema';
import type { AppDeps, TemplateFileRef } from '../../deps';
import { isLockTimeout } from '../../lib/db-errors';
import { type Deadline, reportTimeout } from '../../lib/deadline';
import { AppError } from '../../lib/errors';
import { renderReport } from './service';

/**
 * Класс advisory-блокировок «сборка файла запуска». Ключ — пара int4 (класс, hashtext('<runId>:<формат>')):
 * пространство пар не пересекается с bigint-ключом бэкапа STORAGE_REMOVE_LOCK_KEY (lib/storage-gate.ts).
 * Блокировка живёт в общей БД, поэтому одна сборка на запуск и формат соблюдается для любого числа экземпляров API.
 */
export const RUN_FILE_LOCK_CLASS = 726100002;

export const runDir = (runId: string) => `reports/${runId}`;

/** Всё о запуске со снимком — в `reports/<runId>/` (§24.2). */
export function snapshotPaths(runId: string, ext: TemplateExt) {
  const dir = runDir(runId);
  return {
    dir,
    data: `${dir}/data.json`,
    template: `${dir}/template.${ext}`,
    out: (format: OutputFormat) => `${dir}/out.${format}`,
  };
}

export const snapshotGone = () =>
  new AppError('GONE', 410, 'файл удалён — сформируйте отчёт заново');
export const formatUnavailable = () =>
  new AppError('VALIDATION', 400, 'формат недоступен для этого отчёта');

type RunFileFields = Pick<
  RunRow,
  'id' | 'status' | 'snapshot' | 'outputFormat' | 'filePath' | 'fileDeleted'
>;

/** У запуска со снимком file_path — копия шаблона `reports/<runId>/template.<ext>`. */
export function snapshotExt(filePath: string): TemplateExt {
  return TemplateExt.parse(posix.extname(filePath).slice(1));
}

/** Форматы файла запуска: снимок — все форматы шаблона, старый запуск — только его формат. */
export function allowedFormats(run: RunFileFields): OutputFormat[] {
  if (run.status !== 'ok' || !run.filePath) return [];
  if (run.snapshot) return outputFormatsFor(snapshotExt(run.filePath));
  return run.outputFormat ? [run.outputFormat] : [];
}

/** Формат запроса файла (§24.4): без `format` — PDF у снимка и `output_format` у старого запуска. */
export function resolveRunFormat(run: RunFileFields, requested: string | undefined): OutputFormat {
  const want = requested ?? (run.snapshot ? 'pdf' : run.outputFormat);
  const format = allowedFormats(run).find((f) => f === want);
  if (!format) throw formatUnavailable();
  return format;
}

/** Поля истории: доступные и уже собранные форматы (в порядке `formats`). */
export function runFormats(
  run: RunFileFields,
  built: readonly OutputFormat[],
): { formats: OutputFormat[]; readyFormats: OutputFormat[] } {
  if (run.fileDeleted) return { formats: [], readyFormats: [] };
  const formats = allowedFormats(run);
  return {
    formats,
    readyFormats: run.snapshot ? formats.filter((f) => built.includes(f)) : formats,
  };
}

/** Что удалить в хранилище: каталог снимка целиком или единственный файл старого запуска. */
export function runStoragePath(run: Pick<RunRow, 'id' | 'snapshot' | 'filePath'>): string | null {
  return run.snapshot ? runDir(run.id) : run.filePath;
}

/**
 * Копия шаблона для Carbone. id `run:<runId>` — ключ кэша id шаблона Carbone (§24.2): копия загружается
 * как обычный шаблон, а замена живого шаблона не влияет на запуск.
 */
export function snapshotTemplateRef(
  runId: string,
  ext: TemplateExt,
  version: number,
  file: Buffer,
): TemplateFileRef {
  return { id: `run:${runId}`, version, ext, read: async () => file };
}

const isEnoent = (e: unknown) => (e as NodeJS.ErrnoException)?.code === 'ENOENT';

async function readSnapshotFile(deps: AppDeps, path: string): Promise<Buffer> {
  try {
    return await deps.storage.read(path);
  } catch (e) {
    if (isEnoent(e)) throw snapshotGone();
    throw e;
  }
}

export async function writeSnapshot(
  deps: AppDeps,
  runId: string,
  ext: TemplateExt,
  data: unknown,
  template: Buffer,
): Promise<void> {
  const p = snapshotPaths(runId, ext);
  await deps.storage.write(p.data, Buffer.from(JSON.stringify(data)));
  await deps.storage.write(p.template, template);
}

/**
 * Рендер формата только из снимка: данные и шаблон читаются из каталога запуска до вызова Carbone
 * (нет файла — 410, а не «сервис генерации недоступен»).
 */
export async function renderFromSnapshot(
  deps: AppDeps,
  runId: string,
  ext: TemplateExt,
  version: number,
  format: OutputFormat,
  deadline: Deadline,
): Promise<Buffer> {
  const p = snapshotPaths(runId, ext);
  const [data, template] = await Promise.all([
    readSnapshotFile(deps, p.data),
    readSnapshotFile(deps, p.template),
  ]);
  return renderReport(
    deps,
    snapshotTemplateRef(runId, ext, version, template),
    JSON.parse(data.toString('utf8')) as unknown,
    format,
    deadline,
  );
}

/** Готовый файл формата или сборка из снимка под блокировкой; всё — в пределах `deadline`. */
export async function ensureRunFile(
  deps: AppDeps,
  run: RunRow,
  format: OutputFormat,
  deadline: Deadline,
): Promise<Buffer> {
  const [ready] = await deps.db
    .select({ filePath: reportRunFiles.filePath })
    .from(reportRunFiles)
    .where(and(eq(reportRunFiles.runId, run.id), eq(reportRunFiles.format, format)));
  if (ready) return readSnapshotFile(deps, ready.filePath);
  return deadline.race(buildRunFile(deps, run, format, deadline));
}

async function buildRunFile(
  deps: AppDeps,
  run: RunRow,
  format: OutputFormat,
  deadline: Deadline,
): Promise<Buffer> {
  const ext = snapshotExt(run.filePath!);
  try {
    return await deps.db.transaction(async (tx) => {
      // Ждать чужую сборку — не дольше остатка срока; set_config(..., true) действует до конца транзакции.
      const wait = `${deadline.cap(deps.config.reportTimeoutMs)}ms`;
      await tx.execute(sql`select set_config('lock_timeout', ${wait}, true)`);
      await tx.execute(
        sql`select pg_advisory_xact_lock(${RUN_FILE_LOCK_CLASS}::int, hashtext(${`${run.id}:${format}`}::text))`,
      );
      // FOR SHARE: очистка и удаление пользователя ждут конца сборки и удаляют каталог уже с новым файлом.
      const [cur] = await tx
        .select({ fileDeleted: reportRuns.fileDeleted })
        .from(reportRuns)
        .where(eq(reportRuns.id, run.id))
        .for('share');
      if (!cur || cur.fileDeleted) throw snapshotGone();
      // Пока ждали блокировку, файл мог собрать другой запрос.
      const [done] = await tx
        .select({ filePath: reportRunFiles.filePath })
        .from(reportRunFiles)
        .where(and(eq(reportRunFiles.runId, run.id), eq(reportRunFiles.format, format)));
      if (done) return await readSnapshotFile(deps, done.filePath);
      const file = await renderFromSnapshot(
        deps,
        run.id,
        ext,
        run.templateVersion,
        format,
        deadline,
      );
      const out = snapshotPaths(run.id, ext).out(format);
      await deps.storage.write(out, file);
      await tx.insert(reportRunFiles).values({ runId: run.id, format, filePath: out });
      return file;
    });
  } catch (e) {
    if (isLockTimeout(e)) throw reportTimeout();
    throw e;
  }
}
