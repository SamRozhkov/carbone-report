import {
  RecoveryBody,
  type BackupPhase,
  type MaintenanceStatus,
  type RecoveryTargets,
} from '@carbone-reports/shared';
import type { Redis } from 'ioredis';
import type { App } from '../../app';
import type { AppDeps } from '../../deps';
import { AppError } from '../../lib/errors';
import { backupsDisabled } from '../backups/routes';
import { watchMaintenance } from './flag';

/** Доступны во время обслуживания (§26.3). */
const EXEMPT = new Set(['GET /api/health', 'GET /api/maintenance', 'POST /api/maintenance/retry']);

export const RETRY_LIMIT = 10;
export const RETRY_WINDOW_MS = 15 * 60_000;

/** Лимит повтора по коду: 10 за 15 минут с IP. Без Redis пропускается — остаётся лимит агента (5 попыток на код). */
async function retryAllowed(redis: Redis | null, ip: string): Promise<boolean> {
  if (!redis) return true;
  try {
    const key = `cr:rl-retry:${ip}`;
    const res = await redis.multi().incr(key).pexpire(key, RETRY_WINDOW_MS, 'NX').exec();
    return Number(res?.[0]?.[1] ?? 0) <= RETRY_LIMIT;
  } catch {
    return true;
  }
}

/** Регистрируется до остальных маршрутов: хук onRequest закрывает все, кроме белого списка. */
export function registerMaintenance(app: App, deps: AppDeps): void {
  const watch = watchMaintenance(deps.redis, {
    onEnd: () => {
      app.log.info('режим обслуживания снят: пулы источников данных будут открыты заново');
      deps.sources
        .closeAll()
        .catch((err: unknown) =>
          app.log.warn({ err }, 'не удалось закрыть пулы источников данных'),
        );
    },
  });
  app.addHook('onClose', async () => watch.stop());

  app.addHook('onRequest', async (req) => {
    if (EXEMPT.has(`${req.method} ${req.url.split('?')[0]}`)) return;
    const flag = await watch.get();
    if (flag)
      throw new AppError('maintenance', 503, 'идёт восстановление из бэкапа, повторите позже', {
        phase: flag.phase,
      });
  });

  app.get('/api/maintenance', async (): Promise<MaintenanceStatus> => {
    const flag = await watch.get();
    if (!flag) return { active: false };
    let recovery: RecoveryTargets | null = null;
    if (deps.backupAgent) {
      try {
        const r = await deps.backupAgent.request('GET', '/operation');
        const body = r.body as { recovery?: RecoveryTargets | null } | undefined;
        recovery = r.status === 200 ? (body?.recovery ?? null) : null;
      } catch {
        recovery = null;
      }
    }
    return {
      active: true,
      phase: flag.phase as BackupPhase,
      startedAt: flag.startedAt,
      backup: flag.backup,
      recovery,
    };
  });

  app.post('/api/maintenance/retry', { schema: { body: RecoveryBody } }, async (req, reply) => {
    if (!(await retryAllowed(deps.redis, req.ip)))
      throw new AppError(
        'TOO_MANY_ATTEMPTS',
        429,
        'слишком много попыток ввода кода, повторите через 15 минут',
      );
    if (!deps.backupAgent) throw backupsDisabled();
    const r = await deps.backupAgent.request('POST', '/recovery', req.body);
    // Код в журнал не пишется.
    req.log.warn({ status: r.status, target: req.body.target }, 'повтор восстановления по коду');
    return reply.status(r.status).send(r.body);
  });
}
