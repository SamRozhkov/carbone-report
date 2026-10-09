import { randomUUID } from 'node:crypto';
import {
  IdParams,
  type OutputFormat,
  type ParamsInput,
  type ParamValue,
  PreviewBody,
  RenderBody,
  RunQueryBody,
  RUNS_PAGE_SIZE,
  RunsQuery,
  type RunDto,
  type RunsPage,
} from '@carbone-reports/shared';
import { and, count, desc, eq, inArray, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { App } from '../../app';
import { reportRunFiles, reportRuns, users } from '../../db/schema';
import type { AppDeps } from '../../deps';
import { Deadline } from '../../lib/deadline';
import { AppError, notFound } from '../../lib/errors';
import { contentDisposition, MIME } from '../../lib/http';
import { assertTemplateAccess } from '../access/access';
import { currentUser, type Guards } from '../auth/guards';
import { previewQuery } from '../queries/executor';
import { resolveParams } from '../queries/params';
import { loadTemplateFull, templateFileRef, type TemplateFull } from '../templates/service';
import { collectReportData, renderReport } from './service';
import {
  ensureRunFile,
  renderFromSnapshot,
  resolveRunFormat,
  runFormats,
  snapshotGone,
  snapshotPaths,
  writeSnapshot,
} from './snapshot';

const PREVIEW_ROWS = 50;

/** В запись об ошибке: разрешённые параметры, а если не получилось — только известные шаблону ключи. */
function paramsForErrorRun(full: TemplateFull, input: ParamsInput): Record<string, ParamValue> {
  try {
    return resolveParams(full.params, input);
  } catch {
    const out: Record<string, ParamValue> = {};
    for (const p of full.params) {
      if (Object.hasOwn(input, p.name)) out[p.name] = input[p.name]!;
    }
    return out;
  }
}

export function registerReportRoutes(app: App, deps: AppDeps, guards: Guards): void {
  const { db, storage } = deps;

  app.post(
    '/api/reports/:id/render',
    { preHandler: guards.requireUser, schema: { params: IdParams, body: RenderBody } },
    async (req, reply) => {
      // Срок отсчитывается от начала обработки запроса.
      const deadline = new Deadline(deps.config.reportTimeoutMs);
      const user = currentUser(req);
      // До загрузки и до любой записи запуска: недоступный шаблон не оставляет следов в истории.
      await assertTemplateAccess(db, user, req.params.id);
      const full = await loadTemplateFull(db, req.params.id);
      const runId = randomUUID();
      const started = Date.now();
      const ext = full.row.fileExt;
      const snap = snapshotPaths(runId, ext);
      const base = {
        id: runId,
        templateId: full.row.id,
        templateName: full.row.name,
        templateVersion: full.row.version,
        userId: user.id,
      };
      let snapshotStarted = false;
      try {
        const { data, params } = await collectReportData(deps, full, req.body.params, deadline);
        // Снимок (§24.2): данные и копия файла шаблона; любой формат запуска собирается только из него.
        snapshotStarted = true;
        await writeSnapshot(deps, runId, ext, data, await templateFileRef(deps, full.row).read());
        const pdf = await renderFromSnapshot(deps, runId, ext, full.row.version, 'pdf', deadline);
        await storage.write(snap.out('pdf'), pdf);
        await db.transaction(async (tx) => {
          await tx.insert(reportRuns).values({
            ...base,
            params,
            status: 'ok',
            snapshot: true,
            filePath: snap.template,
            durationMs: Date.now() - started,
          });
          await tx
            .insert(reportRunFiles)
            .values({ runId, format: 'pdf', filePath: snap.out('pdf') });
        });
        return reply.status(201).send({ runId });
      } catch (e) {
        // Незавершённый снимок не нужен. Удаление не ждём: во время бэкапа удаления стоят в очереди.
        if (snapshotStarted) {
          void storage
            .remove(snap.dir)
            .catch((err) => req.log.warn({ err, runId }, 'снимок запуска не удалён'));
        }
        // Ошибки ввода пользователя историю не засоряют.
        if (!(e instanceof AppError && e.code === 'VALIDATION')) {
          try {
            await db.insert(reportRuns).values({
              ...base,
              params: paramsForErrorRun(full, req.body.params),
              status: 'error',
              error: e instanceof AppError ? e.message : 'внутренняя ошибка сервера',
              durationMs: Date.now() - started,
            });
          } catch (insertErr) {
            req.log.error(insertErr);
          }
        }
        throw e;
      }
    },
  );

  app.get(
    '/api/runs',
    { preHandler: guards.requireUser, schema: { querystring: RunsQuery } },
    async (req): Promise<RunsPage> => {
      const me = currentUser(req);
      const q = req.query;
      const where: SQL[] = [];
      // Обычный пользователь всегда видит только свои запуски, фильтр userId игнорируется.
      if (me.role !== 'admin') where.push(eq(reportRuns.userId, me.id));
      else if (q.userId) where.push(eq(reportRuns.userId, q.userId));
      if (q.templateId) where.push(eq(reportRuns.templateId, q.templateId));
      if (q.status) where.push(eq(reportRuns.status, q.status));
      const cond = where.length ? and(...where) : undefined;

      const [rows, [totalRow]] = await Promise.all([
        db
          .select({ run: reportRuns, login: users.login })
          .from(reportRuns)
          .innerJoin(users, eq(users.id, reportRuns.userId))
          .where(cond)
          .orderBy(desc(reportRuns.createdAt), desc(reportRuns.id))
          .limit(RUNS_PAGE_SIZE)
          .offset((q.page - 1) * RUNS_PAGE_SIZE),
        db.select({ n: count() }).from(reportRuns).where(cond),
      ]);

      // Собранные форматы — только для запусков со снимком на этой странице.
      const snapIds = rows.filter(({ run }) => run.snapshot).map(({ run }) => run.id);
      const built = new Map<string, OutputFormat[]>();
      if (snapIds.length > 0) {
        const files = await db
          .select({ runId: reportRunFiles.runId, format: reportRunFiles.format })
          .from(reportRunFiles)
          .where(inArray(reportRunFiles.runId, snapIds));
        for (const f of files) built.set(f.runId, [...(built.get(f.runId) ?? []), f.format]);
      }

      const items: RunDto[] = rows.map(({ run, login }) => ({
        id: run.id,
        templateId: run.templateId,
        templateName: run.templateName,
        templateVersion: run.templateVersion,
        userId: run.userId,
        userLogin: login,
        params: run.params,
        outputFormat: run.outputFormat,
        status: run.status,
        error: run.error,
        fileAvailable: run.status === 'ok' && !!run.filePath && !run.fileDeleted,
        ...runFormats(run, built.get(run.id) ?? []),
        durationMs: run.durationMs,
        createdAt: run.createdAt.toISOString(),
      }));
      return { items, total: totalRow?.n ?? 0, page: q.page, pageSize: RUNS_PAGE_SIZE };
    },
  );

  app.get(
    '/api/runs/:id/file',
    {
      preHandler: guards.requireUser,
      schema: {
        params: IdParams,
        querystring: z.object({
          // Строка, а не enum: любой недоступный формат — одна ошибка «формат недоступен…» (§24.4).
          format: z.string().max(16).optional(),
          inline: z.enum(['0', '1']).optional(),
        }),
      },
    },
    async (req, reply) => {
      // Сборка из снимка — в общем сроке, отсчёт от начала запроса на скачивание (§24.2).
      const deadline = new Deadline(deps.config.reportTimeoutMs);
      const me = currentUser(req);
      const [run] = await db.select().from(reportRuns).where(eq(reportRuns.id, req.params.id));
      // Чужой запуск для пользователя неотличим от несуществующего.
      if (!run || (me.role !== 'admin' && run.userId !== me.id)) throw notFound('запуск');
      if (run.status !== 'ok' || !run.filePath) throw notFound('файл');
      const format = resolveRunFormat(run, req.query.format);
      let content: Buffer;
      if (run.snapshot) {
        if (run.fileDeleted) throw snapshotGone();
        // Ошибка сборки (в том числе CARBONE_COMMUNITY и CONVERT_ERROR) уходит как есть; статус запуска не меняется.
        content = await ensureRunFile(deps, run, format, deadline);
      } else {
        if (run.fileDeleted) throw new AppError('GONE', 410, 'файл удалён по сроку хранения');
        try {
          content = await storage.read(run.filePath);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === 'ENOENT')
            throw new AppError('GONE', 410, 'файл удалён по сроку хранения');
          throw e;
        }
      }
      const date = run.createdAt.toISOString().slice(0, 10);
      return reply
        .header('content-type', MIME[format])
        .header(
          'content-disposition',
          contentDisposition(`${run.templateName} ${date}.${format}`, req.query.inline === '1'),
        )
        .send(content);
    },
  );

  app.post(
    '/api/templates/:id/queries/run',
    { preHandler: guards.requireAdmin, schema: { params: IdParams, body: RunQueryBody } },
    async (req) => {
      const full = await loadTemplateFull(db, req.params.id);
      const { pool, name } = await deps.sources.get(full.row.datasourceId);
      return previewQuery(pool, name, req.body.sql, req.body.params, {
        timeoutMs: deps.config.queryTimeoutMs,
        maxRows: deps.config.queryMaxRows,
        previewRows: PREVIEW_ROWS,
      });
    },
  );

  app.post(
    '/api/templates/:id/preview',
    { preHandler: guards.requireAdmin, schema: { params: IdParams, body: PreviewBody } },
    async (req, reply) => {
      const deadline = new Deadline(deps.config.reportTimeoutMs);
      await assertTemplateAccess(db, currentUser(req), req.params.id);
      const full = await loadTemplateFull(db, req.params.id);
      const { data } = await collectReportData(deps, full, req.body.params, deadline);
      if (req.body.mode === 'data') return data;
      const pdf = await renderReport(deps, templateFileRef(deps, full.row), data, 'pdf', deadline);
      return reply
        .header('content-type', MIME.pdf)
        .header('content-disposition', contentDisposition(`${full.row.name}.pdf`, true))
        .send(pdf);
    },
  );
}
