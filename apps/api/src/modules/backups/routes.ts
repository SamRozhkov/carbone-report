import { BackupNameParams } from '@carbone-reports/shared';
import type { App } from '../../app';
import type { AppDeps } from '../../deps';
import { AppError } from '../../lib/errors';
import { currentUser, type Guards } from '../auth/guards';
import type { AgentClient } from './agent-client';

export const backupsDisabled = () =>
  new AppError(
    'backups_disabled',
    404,
    'управление бэкапами выключено: задайте BACKUP_AGENT_URL и BACKUP_AGENT_TOKEN',
  );

/** Прокси к агенту бэкапа (§26.3), только роль admin. */
export function registerBackupRoutes(app: App, deps: AppDeps, guards: Guards): void {
  const pre = { preHandler: guards.requireAdmin };
  const agent = (): AgentClient => {
    if (!deps.backupAgent) throw backupsDisabled();
    return deps.backupAgent;
  };

  app.get('/api/admin/backups', pre, async (_req, reply) => {
    const r = await agent().request('GET', '/backups');
    return reply.status(r.status).send(r.body);
  });

  app.post('/api/admin/backups', pre, async (req, reply) => {
    const login = currentUser(req).login;
    const r = await agent().request('POST', '/backups', { requestedBy: login });
    if (r.status === 202) req.log.info({ login }, 'бэкап запущен из админки');
    return reply.status(r.status).send(r.body);
  });

  app.post(
    '/api/admin/backups/:name/restore',
    { ...pre, schema: { params: BackupNameParams } },
    async (req, reply) => {
      const login = currentUser(req).login;
      const { name } = req.params;
      const r = await agent().request('POST', `/backups/${encodeURIComponent(name)}/restore`, {
        requestedBy: login,
      });
      if (r.status === 202)
        req.log.warn({ login, backup: name }, 'восстановление из бэкапа запущено из админки');
      return reply.status(r.status).send(r.body);
    },
  );

  app.get('/api/admin/backups/operation', pre, async (_req, reply) => {
    const r = await agent().request('GET', '/operation');
    return reply.status(r.status).send(r.body);
  });
}
