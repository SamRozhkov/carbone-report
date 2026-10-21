import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import {
  CreateTemplateBody,
  EditLockHolderQuery,
  IdParams,
  type OutputFormat,
  outputFormatsFor,
  ParamOptionsBody,
  type ParamOptionsResult,
  type PdfOptions,
  type TemplateChart,
  TemplateChartList,
  TemplateExt,
  TemplateParam,
  TemplateQuery,
  type TemplateEditSummary,
  type TemplateSummary,
  type TemplateTagWarnings,
  UpdateTemplateBody,
} from '@carbone-reports/shared';
import {
  ExportTemplatesBody,
  ImportDecisions,
  type ImportPreview,
  type ImportResult,
  MAX_TRANSFER_ARCHIVE_BYTES,
} from '@carbone-reports/shared/template-transfer';
import { and, asc, eq, getTableColumns } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { App } from '../../app';
import {
  categories,
  datasources,
  templateAttachments,
  templateEditLocks,
  templateCharts,
  templateGroups,
  templateParams,
  templateQueries,
  templates,
  type TemplateRow,
  users,
} from '../../db/schema';
import type { AppDeps } from '../../deps';
import { badRequest, forbidden, notFound } from '../../lib/errors';
import { contentDisposition, isZip, MIME } from '../../lib/http';
import { accessibleTemplates, assertTemplateAccess } from '../access/access';
import {
  assertTemplateEdit,
  canEditTemplate,
  AUTHOR_ROLES,
  deleteRight,
  editableTemplates,
  NO_EDIT_RIGHT,
  templateRights,
} from '../access/permissions';
import { assertNotLockedByOther, lockAlive } from '../edit-lock/service';
import { currentUser, type Guards } from '../auth/guards';
import { orderParams } from '../queries/param-deps';
import { optionsForParam } from '../queries/param-options';
import { checkParamDefaults } from '../queries/params';
import { createBlankDocument } from './blank';
import { assertNoIssues, chartIssues, queryIssuesForCharts } from './charts';
import { findTagWarnings } from './tag-warnings';
import { importInvalid } from './transfer/archive';
import { buildExport } from './transfer/export';
import { applyImport, previewImport } from './transfer/import';
import {
  categoryRefColumns,
  discardUncommittedFile,
  loadTemplate,
  loadTemplateCharts,
  loadTemplateFull,
  loadTemplateQueries,
  lockTemplate,
  templateAttachmentPath,
  templateDir,
  templateFileRef,
  templateFilePath,
  toAdminDetails,
  toDetails,
  toSummary,
} from './service';

const MAX_FILE = 20 * 1024 * 1024;

function uniqueOrFail(values: string[], what: string): void {
  const seen = new Set<string>();
  for (const v of values) {
    if (seen.has(v)) throw badRequest(`${what} "${v}" повторяется`);
    seen.add(v);
  }
}

export function registerTemplateRoutes(app: App, deps: AppDeps, guards: Guards): void {
  const author = { preHandler: guards.requireRole(...AUTHOR_ROLES) };
  const editor = { preHandler: guards.requireTemplateEdit };
  const owner = { preHandler: guards.requireTemplateOwner };
  const anyUser = { preHandler: guards.requireUser };
  const { db, storage } = deps;

  async function ensureDatasource(id: string) {
    const [ds] = await db
      .select({ id: datasources.id })
      .from(datasources)
      .where(eq(datasources.id, id));
    if (!ds) throw badRequest('источник данных не найден');
  }

  async function readUpload(req: FastifyRequest) {
    const fields: Record<string, string> = {};
    let file: { filename: string; data: Buffer } | undefined;
    for await (const part of req.parts({ limits: { fileSize: MAX_FILE } })) {
      if (part.type === 'file') {
        const data = await part.toBuffer(); // при превышении лимита бросает FST_REQ_FILE_TOO_LARGE (413)
        file = { filename: part.filename, data };
      } else {
        fields[part.fieldname] = String(part.value);
      }
    }
    if (!file) throw badRequest('файл не передан');
    const ext = TemplateExt.safeParse(extname(file.filename).slice(1).toLowerCase());
    if (!ext.success) throw badRequest('поддерживаются файлы docx, xlsx, odt, ods, pptx');
    if (!isZip(file.data)) throw badRequest('файл повреждён или не является документом Office');
    return { fields, ext: ext.data, data: file.data };
  }

  /** Архив шаблонов из multipart (поле `file`, до 50 МБ) и текстовые поля. */
  async function readArchiveUpload(req: FastifyRequest) {
    const fields: Record<string, string> = {};
    let data: Buffer | undefined;
    try {
      for await (const part of req.parts({ limits: { fileSize: MAX_TRANSFER_ARCHIVE_BYTES } })) {
        if (part.type === 'file') {
          if (part.fieldname !== 'file') throw badRequest('архив передаётся в поле file');
          data = await part.toBuffer();
        } else fields[part.fieldname] = String(part.value);
      }
    } catch (err) {
      if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
        throw importInvalid(`архив больше ${MAX_TRANSFER_ARCHIVE_BYTES / 1024 / 1024} МБ`);
      }
      throw err;
    }
    if (!data) throw badRequest('файл не передан');
    return { fields, data };
  }

  async function insertTemplate(
    v: {
      name: string;
      description: string;
      datasourceId: string;
      ext: TemplateExt;
      data: Buffer;
      userId: string;
    },
    extra?: {
      defaultOutput?: OutputFormat;
      queries?: TemplateQuery[];
      params?: TemplateParam[];
      charts?: TemplateChart[];
      pdfOptions?: PdfOptions;
      /** Пароль PDF в виде encryptSecret (копия шаблона в той же среде, §37 R7). */
      pdfPasswordEnc?: string | null;
      /** Приложенные файлы (копия шаблона): файлы пишутся под новый идентификатор. */
      attachments?: {
        name: string;
        placement: 'start' | 'end';
        sortOrder: number;
        pages: number;
        pdfa: boolean;
        data: Buffer;
      }[];
      /** Настройки доступа; по умолчанию шаблон закрыт и без категории. */
      categoryId?: string | null;
      public?: boolean;
      /** Скопировать группы доступа (template_groups) этого шаблона. */
      copyGroupsFrom?: string;
    },
  ) {
    await ensureDatasource(v.datasourceId);
    const id = randomUUID();
    const filePath = templateFilePath(id, v.ext, 1);
    const attachmentFiles = (extra?.attachments ?? []).map((a) => ({
      ...a,
      filePath: templateAttachmentPath(id, randomUUID()),
    }));
    try {
      await storage.write(filePath, v.data);
      for (const a of attachmentFiles) await storage.write(a.filePath, a.data);
      return await db.transaction(async (tx) => {
        const [row] = await tx
          .insert(templates)
          .values({
            id,
            name: v.name,
            description: v.description,
            datasourceId: v.datasourceId,
            fileExt: v.ext,
            filePath,
            docKey: randomUUID(),
            updatedBy: v.userId,
            ownerId: v.userId,
            categoryId: extra?.categoryId ?? null,
            public: extra?.public ?? false,
            ...(extra?.pdfOptions ? { pdfOptions: extra.pdfOptions } : {}),
            ...(extra?.pdfPasswordEnc ? { pdfPasswordEnc: extra.pdfPasswordEnc } : {}),
            ...(extra?.defaultOutput ? { defaultOutput: extra.defaultOutput } : {}),
          })
          .returning();
        if (extra?.copyGroupsFrom) {
          const gs = await tx
            .select({ groupId: templateGroups.groupId })
            .from(templateGroups)
            .where(eq(templateGroups.templateId, extra.copyGroupsFrom));
          if (gs.length) {
            await tx
              .insert(templateGroups)
              .values(gs.map((g) => ({ templateId: id, groupId: g.groupId })));
          }
        }
        if (extra?.queries?.length) {
          await tx
            .insert(templateQueries)
            .values(extra.queries.map((q, i) => ({ ...q, templateId: id, sortOrder: i })));
        }
        if (extra?.params?.length) {
          await tx
            .insert(templateParams)
            .values(extra.params.map((p, i) => ({ ...p, templateId: id, sortOrder: i })));
        }
        if (extra?.charts?.length) {
          await tx.insert(templateCharts).values(
            extra.charts.map(({ key, ...config }, i) => ({
              templateId: id,
              key,
              sortOrder: i,
              config,
            })),
          );
        }
        if (attachmentFiles.length) {
          await tx.insert(templateAttachments).values(
            attachmentFiles.map((a) => ({
              templateId: id,
              placement: a.placement,
              sortOrder: a.sortOrder,
              name: a.name,
              filePath: a.filePath,
              size: a.data.length,
              pages: a.pages,
              pdfa: a.pdfa,
            })),
          );
        }
        return row!;
      });
    } catch (err) {
      await storage.remove(templateDir(id)).catch(() => undefined);
      throw err;
    }
  }

  app.get(
    '/api/templates',
    { ...anyUser, schema: { querystring: z.object({ scope: z.literal('edit').optional() }) } },
    async (req): Promise<TemplateSummary[] | TemplateEditSummary[]> => {
      const user = currentUser(req);
      const forEdit = req.query.scope === 'edit';
      // Список конструктора (§43.3) — только авторам шаблонов.
      if (forEdit && !(AUTHOR_ROLES as readonly string[]).includes(user.role)) throw forbidden();
      const lockUser = alias(users, 'lock_user');
      const rows = await db
        .select({
          row: getTableColumns(templates),
          category: categoryRefColumns,
          lockLogin: lockUser.login,
        })
        .from(templates)
        .leftJoin(categories, eq(categories.id, templates.categoryId))
        .leftJoin(templateEditLocks, and(eq(templateEditLocks.templateId, templates.id), lockAlive))
        .leftJoin(lockUser, eq(lockUser.id, templateEditLocks.userId))
        .where(forEdit ? editableTemplates(user) : accessibleTemplates(user))
        .orderBy(asc(templates.name));
      if (forEdit) {
        return rows.map((r) => ({
          ...toSummary(r.row, r.category, r.lockLogin ? { login: r.lockLogin } : null),
          ownerId: r.row.ownerId,
          canDelete: deleteRight(user, r.row),
        }));
      }
      return rows.map((r) =>
        toSummary(
          r.row,
          r.category,
          user.role === 'admin' && r.lockLogin ? { login: r.lockLogin } : null,
        ),
      );
    },
  );

  app.get('/api/templates/:id', { ...anyUser, schema: { params: IdParams } }, async (req) => {
    const user = currentUser(req);
    // Кто может править — получает карточку конструктора; остальные — карточку пользователя по §19.
    if (await canEditTemplate(db, user, req.params.id)) {
      const full = await loadTemplateFull(db, req.params.id);
      return toAdminDetails(full, templateRights(user, full.row));
    }
    await assertTemplateAccess(db, user, req.params.id);
    return toDetails(await loadTemplateFull(db, req.params.id));
  });

  app.post(
    '/api/templates/:id/params/:name/options',
    {
      ...anyUser,
      schema: { params: IdParams.extend({ name: z.string() }), body: ParamOptionsBody },
    },
    async (req): Promise<ParamOptionsResult> => {
      const user = currentUser(req);
      // Превью конструктора: правящему шаблон группы не нужны (§43); остальным — правило §19.
      if (!(await canEditTemplate(db, user, req.params.id))) {
        await assertTemplateAccess(db, user, req.params.id);
      }
      const full = await loadTemplateFull(db, req.params.id);
      return optionsForParam(deps, full, req.params.name, req.body.params);
    },
  );

  app.post(
    '/api/templates',
    { ...author, schema: { body: CreateTemplateBody } },
    async (req, reply) => {
      const row = await insertTemplate({
        ...req.body,
        ext: req.body.blank,
        data: await createBlankDocument(req.body.blank),
        userId: currentUser(req).id,
      });
      return reply.status(201).send(toSummary(row, null));
    },
  );

  app.post('/api/templates/upload', author, async (req, reply) => {
    const { fields, ext, data } = await readUpload(req);
    const meta = z
      .object({
        name: z.string().trim().min(1),
        description: z.string().default(''),
        datasourceId: z.uuid(),
      })
      .safeParse(fields);
    if (!meta.success) throw badRequest('укажите название и источник данных');
    const row = await insertTemplate({ ...meta.data, ext, data, userId: currentUser(req).id });
    return reply.status(201).send(toSummary(row, null));
  });

  app.get(
    '/api/templates/:id/tag-warnings',
    { ...editor, schema: { params: IdParams } },
    async (req): Promise<TemplateTagWarnings> => {
      const row = await loadTemplate(db, req.params.id);
      return findTagWarnings(await templateFileRef(deps, row).read(), row.fileExt);
    },
  );

  app.put(
    '/api/templates/:id/file',
    // holder — вкладка «Документ» той же страницы: её собственная блокировка замене не мешает (§38.2).
    { ...editor, schema: { params: IdParams, querystring: EditLockHolderQuery.partial() } },
    async (req) => {
      const row = await loadTemplate(db, req.params.id);
      const { ext, data } = await readUpload(req);
      if (ext !== row.fileExt) throw badRequest(`ожидается файл .${row.fileExt}`);
      let written: string | undefined;
      let previous: string | undefined;
      let updated: TemplateRow;
      try {
        updated = await db.transaction(async (tx) => {
          // Блокировка строки: ручная замена не должна пересекаться с callback OnlyOffice.
          const [cur] = await tx
            .select()
            .from(templates)
            .where(eq(templates.id, row.id))
            .for('update');
          if (!cur) throw notFound('шаблон');
          // Документ редактирует другая вкладка — файл не заменяется; своя (holder) не мешает (§38.2).
          await assertNotLockedByOther(tx, cur.id, req.query.holder ?? null);
          // Новая версия — новый файл: при сбое коммита строка продолжает указывать на прежний.
          previous = cur.filePath;
          written = templateFilePath(cur.id, cur.fileExt, cur.version + 1);
          await storage.write(written, data);
          const [u] = await tx
            .update(templates)
            .set({
              version: cur.version + 1,
              filePath: written,
              docKey: randomUUID(),
              updatedAt: new Date(),
              updatedBy: currentUser(req).id,
              lastSaveError: null,
              lastSaveErrorAt: null,
            })
            .where(eq(templates.id, cur.id))
            .returning();
          return u!;
        });
      } catch (err) {
        // Транзакция не прошла: новый файл — сирота, убираем.
        if (written) {
          await discardUncommittedFile(deps, row.id, written, req.log).catch((e) =>
            req.log.warn({ err: e, filePath: written }, 'несохранённый файл шаблона не удалён'),
          );
        }
        throw err;
      }
      // Удаление — в фоне: во время бэкапа оно ждёт блокировку, а ответ ждать не должен (§17.1).
      if (previous && previous !== updated.filePath) {
        void storage
          .remove(previous)
          .catch((e) => req.log.warn({ err: e }, 'старый файл шаблона не удалён'));
      }
      return toAdminDetails(
        await loadTemplateFull(db, updated.id),
        templateRights(currentUser(req), updated),
      );
    },
  );

  app.patch(
    '/api/templates/:id',
    { ...editor, schema: { params: IdParams, body: UpdateTemplateBody } },
    async (req) => {
      const row = await loadTemplate(db, req.params.id);
      if (
        req.body.defaultOutput &&
        !outputFormatsFor(row.fileExt).includes(req.body.defaultOutput)
      ) {
        throw badRequest(`формат ${req.body.defaultOutput} недоступен для .${row.fileExt}`);
      }
      if (req.body.datasourceId) await ensureDatasource(req.body.datasourceId);
      await db
        .update(templates)
        .set({ ...req.body, updatedAt: new Date(), updatedBy: currentUser(req).id })
        .where(eq(templates.id, row.id));
      return toAdminDetails(
        await loadTemplateFull(db, row.id),
        templateRights(currentUser(req), row),
      );
    },
  );

  app.delete(
    '/api/templates/:id',
    { ...owner, schema: { params: IdParams } },
    async (req, reply) => {
      const row = await loadTemplate(db, req.params.id);
      await db.transaction(async (tx) => {
        const [cur] = await tx
          .select({ id: templates.id, ownerId: templates.ownerId })
          .from(templates)
          .where(eq(templates.id, row.id))
          .for('update');
        if (!cur) throw notFound('шаблон');
        // Владельца мог сменить админ, пока запрос ждал блокировку: право проверяется ещё раз под ней.
        if (!deleteRight(currentUser(req), cur)) throw forbidden(NO_EDIT_RIGHT);
        await assertNotLockedByOther(tx, cur.id, null);
        await tx.delete(templates).where(eq(templates.id, cur.id));
      });
      await storage.remove(templateDir(row.id));
      // Строка могла ещё указывать на путь старого формата templates/<id>.<ext>.
      if (!row.filePath.startsWith(`${templateDir(row.id)}/`)) await storage.remove(row.filePath);
      return reply.status(204).send();
    },
  );

  // Выгрузка в архив (§33.2): доступна и в режиме обслуживания — ничего не меняет.
  app.post(
    '/api/templates/export',
    { ...author, schema: { body: ExportTemplatesBody } },
    async (req, reply) => {
      // Редактор выгружает только то, что может править; первый отказ — его код (§43.3).
      const user = currentUser(req);
      if (user.role !== 'admin') {
        for (const id of req.body.ids) await assertTemplateEdit(db, user, id);
      }
      // Настройки подключения источника видит только admin; редактору — одно имя (§43.2).
      const { filename, buffer } = await buildExport(deps, req.body.ids, {
        withConnection: user.role === 'admin',
      });
      return reply
        .header('content-type', 'application/zip')
        .header('cache-control', 'no-store')
        .header('content-disposition', contentDisposition(filename))
        .send(buffer);
    },
  );

  // Загрузка из архива (§33.2); в режиме обслуживания закрыта вместе с прочими изменениями.
  app.post('/api/templates/import/preview', author, async (req): Promise<ImportPreview> => {
    const { data } = await readArchiveUpload(req);
    return previewImport(deps, data, currentUser(req));
  });

  app.post('/api/templates/import', author, async (req): Promise<ImportResult> => {
    const { fields, data } = await readArchiveUpload(req);
    let raw: unknown;
    try {
      raw = JSON.parse(fields.decisions ?? '');
    } catch {
      throw badRequest('не переданы решения по шаблонам (decisions)');
    }
    const decisions = ImportDecisions.safeParse(raw);
    if (!decisions.success) {
      const issue = decisions.error.issues[0]!;
      throw badRequest(
        `неверные решения по шаблонам: ${issue.path.join('.')} ${issue.message}`.trim(),
      );
    }
    return applyImport(deps, data, decisions.data, currentUser(req), req.log);
  });

  app.post(
    '/api/templates/:id/duplicate',
    { ...editor, schema: { params: IdParams } },
    async (req, reply) => {
      const src = await loadTemplateFull(db, req.params.id);
      const row = await insertTemplate(
        {
          name: `${src.row.name} (копия)`,
          description: src.row.description,
          datasourceId: src.row.datasourceId,
          ext: src.row.fileExt,
          data: await templateFileRef(deps, src.row).read(),
          userId: currentUser(req).id,
        },
        {
          defaultOutput: src.row.defaultOutput,
          queries: src.queries,
          params: src.params,
          charts: src.charts,
          pdfOptions: src.pdfOptions,
          pdfPasswordEnc: src.row.pdfPasswordEnc,
          attachments: await Promise.all(
            src.attachments.map(async (a) => ({
              name: a.name,
              placement: a.placement,
              sortOrder: a.sortOrder,
              pages: a.pages,
              pdfa: a.pdfa,
              data: await storage.read(a.filePath),
            })),
          ),
          categoryId: src.row.categoryId,
          public: src.row.public,
          copyGroupsFrom: src.row.id,
        },
      );
      return reply.status(201).send(toSummary(row, src.category));
    },
  );

  app.get(
    '/api/templates/:id/download',
    { ...editor, schema: { params: IdParams } },
    async (req, reply) => {
      const row = await loadTemplate(db, req.params.id);
      const data = await templateFileRef(deps, row).read();
      return reply
        .header('content-type', MIME[row.fileExt])
        .header('content-disposition', contentDisposition(`${row.name}.${row.fileExt}`))
        .send(data);
    },
  );

  app.put(
    '/api/templates/:id/queries',
    { ...editor, schema: { params: IdParams, body: z.array(TemplateQuery) } },
    async (req) => {
      const row = await loadTemplate(db, req.params.id);
      uniqueOrFail(
        req.body.map((q) => q.key),
        'ключ запроса',
      );
      await db.transaction(async (tx) => {
        // Проверка графиков — под блокировкой строки: параллельный PUT …/charts ждёт.
        await lockTemplate(tx, row.id);
        assertNoIssues(queryIssuesForCharts(req.body, await loadTemplateCharts(tx, row.id)));
        await tx.delete(templateQueries).where(eq(templateQueries.templateId, row.id));
        if (req.body.length) {
          await tx
            .insert(templateQueries)
            .values(req.body.map((q, i) => ({ ...q, templateId: row.id, sortOrder: i })));
        }
        await tx
          .update(templates)
          .set({ updatedAt: new Date(), updatedBy: currentUser(req).id })
          .where(eq(templates.id, row.id));
      });
      return toAdminDetails(
        await loadTemplateFull(db, row.id),
        templateRights(currentUser(req), row),
      );
    },
  );

  app.put(
    '/api/templates/:id/params',
    { ...editor, schema: { params: IdParams, body: z.array(TemplateParam) } },
    async (req) => {
      const row = await loadTemplate(db, req.params.id);
      uniqueOrFail(
        req.body.map((p) => p.name),
        'параметр',
      );
      orderParams(req.body); // только проверка графа; порядок хранения не меняется
      checkParamDefaults(req.body);
      await db.transaction(async (tx) => {
        await tx.delete(templateParams).where(eq(templateParams.templateId, row.id));
        if (req.body.length) {
          await tx
            .insert(templateParams)
            .values(req.body.map((p, i) => ({ ...p, templateId: row.id, sortOrder: i })));
        }
        await tx
          .update(templates)
          .set({ updatedAt: new Date(), updatedBy: currentUser(req).id })
          .where(eq(templates.id, row.id));
      });
      return toAdminDetails(
        await loadTemplateFull(db, row.id),
        templateRights(currentUser(req), row),
      );
    },
  );

  app.put(
    '/api/templates/:id/charts',
    { ...editor, schema: { params: IdParams, body: TemplateChartList } },
    async (req) => {
      const row = await loadTemplate(db, req.params.id);
      await db.transaction(async (tx) => {
        // Проверка запросов — под блокировкой строки: параллельный PUT …/queries ждёт.
        await lockTemplate(tx, row.id);
        assertNoIssues(chartIssues(req.body, await loadTemplateQueries(tx, row.id)));
        await tx.delete(templateCharts).where(eq(templateCharts.templateId, row.id));
        if (req.body.length) {
          await tx.insert(templateCharts).values(
            req.body.map(({ key, ...config }, i) => ({
              templateId: row.id,
              key,
              sortOrder: i,
              config,
            })),
          );
        }
        await tx
          .update(templates)
          .set({ updatedAt: new Date(), updatedBy: currentUser(req).id })
          .where(eq(templates.id, row.id));
      });
      return toAdminDetails(
        await loadTemplateFull(db, row.id),
        templateRights(currentUser(req), row),
      );
    },
  );
}
