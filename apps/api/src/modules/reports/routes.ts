import { randomUUID } from 'node:crypto';
import {
  IdParams,
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
import { and, count, desc, eq, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { App } from '../../app';
import { reportRuns, users } from '../../db/schema';
import type { AppDeps } from '../../deps';
import { AppError, notFound } from '../../lib/errors';
import { contentDisposition, MIME } from '../../lib/http';
import { currentUser, type Guards } from '../auth/guards';
import { previewQuery } from '../queries/executor';
import { resolveParams } from '../queries/params';
import { loadTemplateFull, type TemplateFull } from '../templates/service';
import { assertFormat, collectReportData, renderReport } from './service';

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
      const user = currentUser(req);
      const full = await loadTemplateFull(db, req.params.id);
      assertFormat(full, req.body.format);
      const runId = randomUUID();
      const started = Date.now();
      const base = {
        id: runId,
        templateId: full.row.id,
        templateName: full.row.name,
        templateVersion: full.row.version,
        userId: user.id,
        outputFormat: req.body.format,
      };
      try {
        const { data, params } = await collectReportData(deps, full, req.body.params);
        const file = await renderReport(deps, full, data, req.body.format);
        const filePath = `reports/${runId}.${req.body.format}`;
        await storage.write(filePath, file);
        try {
          await db
            .insert(reportRuns)
            .values({ ...base, params, status: 'ok', filePath, durationMs: Date.now() - started });
        } catch (insertErr) {
          await storage.remove(filePath).catch(() => undefined);
          throw insertErr;
        }
        return reply.status(201).send({ runId });
      } catch (e) {
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
        querystring: z.object({ inline: z.enum(['0', '1']).optional() }),
      },
    },
    async (req, reply) => {
      const me = currentUser(req);
      const [run] = await db.select().from(reportRuns).where(eq(reportRuns.id, req.params.id));
      // Чужой запуск для пользователя неотличим от несуществующего.
      if (!run || (me.role !== 'admin' && run.userId !== me.id)) throw notFound('запуск');
      if (run.status !== 'ok' || !run.filePath) throw notFound('файл');
      if (run.fileDeleted) throw new AppError('GONE', 410, 'файл удалён по сроку хранения');
      let content: Buffer;
      try {
        content = await storage.read(run.filePath);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT')
          throw new AppError('GONE', 410, 'файл удалён по сроку хранения');
        throw e;
      }
      const date = run.createdAt.toISOString().slice(0, 10);
      return reply
        .header('content-type', MIME[run.outputFormat])
        .header(
          'content-disposition',
          contentDisposition(
            `${run.templateName} ${date}.${run.outputFormat}`,
            req.query.inline === '1',
          ),
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
      const full = await loadTemplateFull(db, req.params.id);
      const { data } = await collectReportData(deps, full, req.body.params);
      if (req.body.mode === 'data') return data;
      const pdf = await renderReport(deps, full, data, 'pdf');
      return reply
        .header('content-type', MIME.pdf)
        .header('content-disposition', contentDisposition(`${full.row.name}.pdf`, true))
        .send(pdf);
    },
  );
}
