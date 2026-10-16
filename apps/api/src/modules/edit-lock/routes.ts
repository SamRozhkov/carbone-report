import {
  EditLockBody,
  EditLockHolderQuery,
  EditLockTakeoverBody,
  IdParams,
  type EditLockState,
} from '@carbone-reports/shared';
import type { App } from '../../app';
import type { AppDeps } from '../../deps';
import { currentUser, type Guards } from '../auth/guards';
import { acquireLock, peekLock, releaseLock, takeOverLock } from './service';

export function registerEditLockRoutes(app: App, deps: AppDeps, guards: Guards): void {
  const admin = { preHandler: guards.requireAdmin };

  app.post(
    '/api/templates/:id/edit-lock',
    { ...admin, schema: { params: IdParams, body: EditLockBody } },
    async (req): Promise<EditLockState> => {
      const { holder, acquire } = req.body;
      const userId = currentUser(req).id;
      return acquire
        ? acquireLock(deps.db, req.params.id, holder, userId)
        : peekLock(deps.db, req.params.id, holder, userId);
    },
  );

  app.post(
    '/api/templates/:id/edit-lock/takeover',
    { ...admin, schema: { params: IdParams, body: EditLockTakeoverBody } },
    async (req): Promise<EditLockState> => {
      const { previous, docKey } = await takeOverLock(
        deps.db,
        req.params.id,
        req.body.holder,
        currentUser(req).id,
      );
      if (previous) {
        // Правки прежнего редактора — в общей сессии документа; сохранение — на всякий случай (§38.1).
        await deps.onlyoffice.forceSave(docKey).catch((err: unknown) => {
          req.log.warn({ templateId: req.params.id, err }, 'forcesave при перехвате не удался');
        });
      }
      return { state: 'mine' };
    },
  );

  app.delete(
    '/api/templates/:id/edit-lock',
    { ...admin, schema: { params: IdParams, querystring: EditLockHolderQuery } },
    async (req, reply) => {
      await releaseLock(deps.db, req.params.id, req.query.holder);
      return reply.status(204).send();
    },
  );
}
