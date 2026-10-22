import { EditLockHolderQuery, EditLockTakeoverBody, IdParams } from '@carbone-reports/shared';
import { z } from 'zod';
import type { App } from '../../app';
import type { AppDeps } from '../../deps';
import { AppError } from '../../lib/errors';
import { MIME } from '../../lib/http';
import { currentUser, type Guards } from '../auth/guards';
import { activeLock, assertLockedBy } from '../edit-lock/service';
import { loadTemplate, templateFileRef } from '../templates/service';
import { handleCallback } from './callback';
import { buildEditorConfig } from './editor-config';
import { verifyFileToken } from './jwt';

export function registerOnlyOfficeRoutes(app: App, deps: AppDeps, guards: Guards): void {
  app.get(
    '/api/templates/:id/editor-config',
    {
      preHandler: guards.requireTemplateEdit,
      schema: { params: IdParams, querystring: EditLockHolderQuery },
    },
    async (req) => {
      const row = await loadTemplate(deps.db, req.params.id);
      const lock = await activeLock(deps.db, row.id);
      return buildEditorConfig(
        deps,
        row,
        currentUser(req),
        lock?.holder === req.query.holder,
        req.locale,
      );
    },
  );

  app.post(
    '/api/templates/:id/save',
    {
      preHandler: guards.requireTemplateEdit,
      schema: { params: IdParams, body: EditLockTakeoverBody },
    },
    async (req, reply) => {
      const row = await loadTemplate(deps.db, req.params.id);
      await assertLockedBy(deps.db, row.id, req.body.holder);
      await deps.onlyoffice.forceSave(row.docKey);
      return reply.status(204).send();
    },
  );

  // Маршруты /internal/* не проксируются nginx наружу: их вызывает только Document Server.
  app.get(
    '/internal/templates/:id/file',
    { schema: { params: IdParams, querystring: z.object({ t: z.string().optional() }) } },
    async (req, reply) => {
      const ok =
        req.query.t && (await verifyFileToken(req.query.t, req.params.id, deps.config.appSecret));
      if (!ok) throw new AppError('FORBIDDEN', 403, 'неверный токен файла');
      const row = await loadTemplate(deps.db, req.params.id);
      return reply
        .header('content-type', MIME[row.fileExt])
        .send(await templateFileRef(deps, row).read());
    },
  );

  app.post('/internal/onlyoffice/callback/:id', { schema: { params: IdParams } }, async (req) => {
    await handleCallback(deps, req.params.id, req.body, req.headers.authorization, req.log);
    return { error: 0 };
  });
}
