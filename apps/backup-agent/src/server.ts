import { createHash, timingSafeEqual } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import Fastify, { type FastifyReply } from 'fastify';
import { z } from 'zod';
import type { BackupAgent, StartResult } from './agent';
import { BACKUP_NAME_RE, listBackups } from './backups';

export type AgentApi = Pick<BackupAgent, 'startBackup' | 'startRestore' | 'recover' | 'operation'>;

const err = (code: string, message: string) => ({ error: { code, message } });
const digest = (s: string) => createHash('sha256').update(s).digest();

const RequestedBy = z.object({ requestedBy: z.string().trim().min(1).max(256).default('api') });
const RecoveryBody = z.object({
  code: z.string().trim().min(1).max(64),
  target: z.enum(['same', 'pre-restore']),
});

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export function buildServer(o: { agent: AgentApi; token: string; backupsDir: string }) {
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024 });
  const want = digest(o.token);

  // Сравнение за постоянное время: сравниваются sha256 (одинаковой длины) — ни длина, ни
  // совпавший префикс токена не влияют на время ответа.
  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'GET' && req.url === '/health') return;
    const header = req.headers.authorization ?? '';
    const got = digest(header.startsWith('Bearer ') ? header.slice(7) : '');
    if (!timingSafeEqual(got, want)) {
      reply.code(401).send(err('UNAUTHORIZED', 'требуется токен агента'));
      return reply;
    }
  });

  const started = (reply: FastifyReply, r: StartResult) =>
    'busy' in r
      ? reply
          .code(409)
          .send({ ...err('BUSY', 'уже выполняется другая операция с бэкапами'), busy: r.busy })
      : reply.code(202).send(r);

  const badRequest = (reply: FastifyReply) =>
    reply.code(400).send(err('BAD_REQUEST', 'неверные данные запроса'));

  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/backups', async () => listBackups(o.backupsDir));

  app.post('/backups', async (req, reply) => {
    const b = RequestedBy.safeParse(req.body ?? {});
    if (!b.success) return badRequest(reply);
    return started(reply, await o.agent.startBackup(b.data.requestedBy));
  });

  app.post<{ Params: { name: string } }>('/backups/:name/restore', async (req, reply) => {
    const { name } = req.params;
    if (!BACKUP_NAME_RE.test(name))
      return reply.code(400).send(err('BAD_NAME', 'неверное имя бэкапа'));
    if (!(await isDir(join(o.backupsDir, name))))
      return reply.code(404).send(err('NOT_FOUND', 'бэкап не найден'));
    const b = RequestedBy.safeParse(req.body ?? {});
    if (!b.success) return badRequest(reply);
    return started(reply, await o.agent.startRestore(name, b.data.requestedBy));
  });

  app.get('/operation', async (_req, reply) => {
    const op = await o.agent.operation();
    return op ? op : reply.code(204).send();
  });

  app.post('/recovery', async (req, reply) => {
    const b = RecoveryBody.safeParse(req.body ?? {});
    if (!b.success) return badRequest(reply);
    const r = await o.agent.recover(b.data.code, b.data.target);
    if ('error' in r) {
      if (r.error === 'bad-target')
        return reply.code(400).send(err('BAD_TARGET', 'нет бэкапа до восстановления'));
      if (r.error === 'no-recovery')
        return reply.code(409).send(err('NO_RECOVERY', 'восстановление по коду не требуется'));
      return reply
        .code(403)
        .send(
          err(
            'BAD_CODE',
            r.burned
              ? 'неверный код восстановления; после 5 неверных попыток код заменён — новый код в журнале сервиса backup (docker compose logs backup)'
              : 'неверный код восстановления',
          ),
        );
    }
    return started(reply, r);
  });

  return app;
}

const DNS_ERRORS = new Set(['EAI_AGAIN', 'ENOTFOUND']);

/**
 * listen на имени хоста — один DNS-запрос: если псевдоним сети ещё не разрешается (контейнер только
 * подключается к сети), listen повторяется attempts раз с паузой delayMs. Прочие ошибки — сразу.
 * После последней попытки — ошибка с понятным сообщением (main печатает его и выходит с кодом 1).
 */
export async function listenRetrying(
  listen: () => Promise<unknown>,
  host: string,
  log: (line: string) => void,
  o: { attempts?: number; delayMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
  const attempts = o.attempts ?? 10;
  const delayMs = o.delayMs ?? 1000;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 1; ; i++) {
    try {
      await listen();
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (!code || !DNS_ERRORS.has(code)) throw e;
      if (i >= attempts)
        throw new Error(
          `адрес BACKUP_AGENT_HOST «${host}» не разрешается (${code}) после ${attempts} попыток: проверьте BACKUP_AGENT_HOST и сеть контейнера`,
          { cause: e },
        );
      log(`адрес BACKUP_AGENT_HOST не разрешается: ${host} (${code}), попытка ${i} из ${attempts}`);
      await sleep(delayMs);
    }
  }
}
