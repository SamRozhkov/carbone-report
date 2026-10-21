import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import {
  hasPdfProtection,
  IdParams,
  MAX_PDF_ATTACHMENT_BYTES,
  MAX_PDF_ATTACHMENT_PAGES,
  MAX_PDF_ATTACHMENTS,
  MoveAttachmentBody,
  normalizePdfOptions,
  PDF_PROTECTION_PDFA_MESSAGE,
  PDF_SIGNATURE_PROTECTION_MESSAGE,
  PdfOptions,
  PdfPlacement,
  SavePdfOptionsBody,
} from '@carbone-reports/shared';
import { and, eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { App } from '../../app';
import { templateAttachments, templates } from '../../db/schema';
import type { AppDeps } from '../../deps';
import { encryptSecret } from '../../lib/crypto';
import { badRequest, notFound } from '../../lib/errors';
import { templateRights } from '../access/permissions';
import { currentUser, type Guards } from '../auth/guards';
import { inspectPdf, PdfInputError } from '../pdf/inspect';
import { assertNoIssues } from './charts';
import { pdfaMessage, pdfOptionIssues } from './pdf';
import {
  type DbTx,
  loadTemplate,
  loadTemplateAttachments,
  loadTemplateFull,
  lockTemplate,
  templateAttachmentPath,
  toAdminDetails,
} from './service';

const AttachmentParams = IdParams.extend({ aid: z.uuid('неверный идентификатор') });

/** Настройки PDF и приложенные файлы шаблона (§36.1, §36.3); всё — под блокировкой строки шаблона. */
export function registerTemplatePdfRoutes(app: App, deps: AppDeps, guards: Guards): void {
  const admin = { preHandler: guards.requireAdmin };
  const { db, storage } = deps;

  const touch = (tx: DbTx, id: string, userId: string) =>
    tx
      .update(templates)
      .set({ updatedAt: new Date(), updatedBy: userId })
      .where(eq(templates.id, id));

  /** Перенумеровывает группы подряд с 0 в заданном порядке. */
  async function renumber(tx: DbTx, rows: { id: string; placement: PdfPlacement }[]) {
    const next = { start: 0, end: 0 };
    for (const r of rows) {
      await tx
        .update(templateAttachments)
        .set({ placement: r.placement, sortOrder: next[r.placement]++ })
        .where(eq(templateAttachments.id, r.id));
    }
  }

  async function readPdfUpload(req: FastifyRequest) {
    let file: { filename: string; data: Buffer } | undefined;
    const fields: Record<string, string> = {};
    for await (const part of req.parts({ limits: { fileSize: MAX_PDF_ATTACHMENT_BYTES } })) {
      if (part.type === 'file') {
        if (part.fieldname !== 'file') throw badRequest('файл передаётся в поле file');
        file = { filename: part.filename, data: await part.toBuffer() };
      } else fields[part.fieldname] = String(part.value);
    }
    if (!file) throw badRequest('файл не передан');
    const placement = PdfPlacement.safeParse(fields.placement ?? 'end');
    if (!placement.success) throw badRequest('placement: start или end');
    const name = basename(file.filename || 'file.pdf').slice(0, 200) || 'file.pdf';
    return { name, data: file.data, placement: placement.data };
  }

  /** Файл, на который не ссылается ни одна строка (транзакция не прошла), удаляется. */
  async function discardAttachmentFile(path: string, req: FastifyRequest) {
    try {
      const [ref] = await db
        .select({ id: templateAttachments.id })
        .from(templateAttachments)
        .where(eq(templateAttachments.filePath, path));
      if (!ref) await storage.remove(path);
    } catch (err) {
      req.log.warn({ err, filePath: path }, 'несохранённый приложенный файл не удалён');
    }
  }

  app.put(
    '/api/templates/:id/pdf-options',
    { ...admin, schema: { params: IdParams, body: SavePdfOptionsBody } },
    async (req) => {
      const row = await loadTemplate(db, req.params.id);
      const { password, ...rest } = req.body;
      const options = normalizePdfOptions(rest);
      assertNoIssues(pdfOptionIssues(options));
      await db.transaction(async (tx) => {
        // Правила PDF/A — под блокировкой строки: параллельная загрузка приложения ждёт.
        await lockTemplate(tx, row.id);
        // Итоговое состояние пароля (R3 §37): не передан — сохранённый.
        let passwordSet = false;
        if (options.pdfa || options.signature) {
          const [cur] = await tx
            .select({ enc: templates.pdfPasswordEnc })
            .from(templates)
            .where(eq(templates.id, row.id));
          passwordSet = password === undefined ? cur!.enc !== null : password !== null;
        }
        if (options.pdfa) {
          const bad = (await loadTemplateAttachments(tx, row.id)).find((a) => !a.pdfa);
          if (bad) assertNoIssues([{ path: '/pdfa', message: pdfaMessage(bad.name) }]);
          if (hasPdfProtection(options, passwordSet))
            assertNoIssues([{ path: '/pdfa', message: PDF_PROTECTION_PDFA_MESSAGE }]);
        }
        // §39.2: подпись несовместима с паролем и запретами.
        if (options.signature && hasPdfProtection(options, passwordSet))
          assertNoIssues([{ path: '/signature', message: PDF_SIGNATURE_PROTECTION_MESSAGE }]);
        await tx
          .update(templates)
          .set({
            pdfOptions: options,
            ...(password === undefined
              ? {}
              : {
                  pdfPasswordEnc:
                    password === null ? null : encryptSecret(password, deps.config.encryptionKey),
                }),
          })
          .where(eq(templates.id, row.id));
        await touch(tx, row.id, currentUser(req).id);
      });
      return toAdminDetails(
        await loadTemplateFull(db, row.id),
        templateRights(currentUser(req), row),
      );
    },
  );

  app.post(
    '/api/templates/:id/attachments',
    { ...admin, schema: { params: IdParams } },
    async (req, reply) => {
      const row = await loadTemplate(db, req.params.id);
      const { name, data, placement } = await readPdfUpload(req);
      let info: { pages: number; pdfa: boolean };
      try {
        info = await inspectPdf(data);
      } catch (e) {
        if (e instanceof PdfInputError) throw badRequest(e.message);
        throw e;
      }
      const path = templateAttachmentPath(row.id, randomUUID());
      await storage.write(path, data);
      try {
        await db.transaction(async (tx) => {
          await lockTemplate(tx, row.id);
          const cur = await loadTemplateAttachments(tx, row.id);
          if (cur.length >= MAX_PDF_ATTACHMENTS)
            throw badRequest(`в шаблоне не больше ${MAX_PDF_ATTACHMENTS} приложенных файлов`);
          if (cur.reduce((s, a) => s + a.pages, 0) + info.pages > MAX_PDF_ATTACHMENT_PAGES)
            throw badRequest(
              `в приложенных файлах шаблона не больше ${MAX_PDF_ATTACHMENT_PAGES} страниц`,
            );
          const [t] = await tx
            .select({ pdfOptions: templates.pdfOptions })
            .from(templates)
            .where(eq(templates.id, row.id));
          if (PdfOptions.parse(t!.pdfOptions).pdfa && !info.pdfa)
            throw badRequest(pdfaMessage(name));
          await tx.insert(templateAttachments).values({
            templateId: row.id,
            placement,
            sortOrder: cur.filter((a) => a.placement === placement).length,
            name,
            filePath: path,
            size: data.length,
            pages: info.pages,
            pdfa: info.pdfa,
          });
          await touch(tx, row.id, currentUser(req).id);
        });
      } catch (err) {
        await discardAttachmentFile(path, req);
        throw err;
      }
      return reply
        .status(201)
        .send(
          toAdminDetails(await loadTemplateFull(db, row.id), templateRights(currentUser(req), row)),
        );
    },
  );

  app.patch(
    '/api/templates/:id/attachments/:aid',
    { ...admin, schema: { params: AttachmentParams, body: MoveAttachmentBody } },
    async (req) => {
      const row = await loadTemplate(db, req.params.id);
      await db.transaction(async (tx) => {
        await lockTemplate(tx, row.id);
        const rows = await loadTemplateAttachments(tx, row.id);
        const cur = rows.find((r) => r.id === req.params.aid);
        if (!cur) throw notFound('приложенный файл');
        const target = req.body.placement ?? cur.placement;
        const rest = rows.filter((r) => r.id !== cur.id);
        const group = rest.filter((r) => r.placement === target);
        const at = Math.min(req.body.sortOrder ?? group.length, group.length);
        group.splice(at, 0, { ...cur, placement: target });
        const other = rest.filter((r) => r.placement !== target);
        await renumber(tx, target === 'start' ? [...group, ...other] : [...other, ...group]);
        await touch(tx, row.id, currentUser(req).id);
      });
      return toAdminDetails(
        await loadTemplateFull(db, row.id),
        templateRights(currentUser(req), row),
      );
    },
  );

  app.delete(
    '/api/templates/:id/attachments/:aid',
    { ...admin, schema: { params: AttachmentParams } },
    async (req) => {
      const row = await loadTemplate(db, req.params.id);
      const removed = await db.transaction(async (tx) => {
        await lockTemplate(tx, row.id);
        const [del] = await tx
          .delete(templateAttachments)
          .where(
            and(
              eq(templateAttachments.id, req.params.aid),
              eq(templateAttachments.templateId, row.id),
            ),
          )
          .returning();
        if (!del) throw notFound('приложенный файл');
        await renumber(tx, await loadTemplateAttachments(tx, row.id));
        await touch(tx, row.id, currentUser(req).id);
        return del;
      });
      // Удаление — в фоне: во время бэкапа оно ждёт блокировку (§17.1).
      void storage
        .remove(removed.filePath)
        .catch((e) => req.log.warn({ err: e }, 'приложенный файл не удалён'));
      return toAdminDetails(
        await loadTemplateFull(db, row.id),
        templateRights(currentUser(req), row),
      );
    },
  );
}
