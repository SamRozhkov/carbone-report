import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import { createInterface } from 'node:readline';
import type { Redact } from './redact';

export type Out = (line: string) => void;

export interface RunOptions {
  env: NodeJS.ProcessEnv;
  out: Out;
  redact: Redact;
}

export type Runner = (cmd: string, args: string[], o: RunOptions) => Promise<void>;

/**
 * Дочерний процесс: каждая строка stdout и stderr проходит фильтр секретов и уходит в out.
 * Ненулевой код — ошибка с последней непустой строкой вывода (обычно это текст ошибки скрипта).
 */
export const run: Runner = (cmd, args, o) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: o.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let last = '';
    const onLine = (raw: string) => {
      const line = o.redact(raw);
      if (line.trim()) last = line.trim();
      o.out(line);
    };
    createInterface({ input: child.stdout }).on('line', onLine);
    createInterface({ input: child.stderr }).on('line', onLine);
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) return resolve();
      const why = last || (signal ? `сигнал ${signal}` : `код ${code}`);
      reject(new Error(`${basename(cmd)}: ${why}`));
    });
  });

/**
 * Окружение скриптов: без токена агента и REDIS_URL (скриптам они не нужны), умолчания PG*
 * — как в backup.sh. extra — переменные для конкретного вызова (BACKUP_NAME, RESTORE_DIR).
 */
export function childEnv(
  env: NodeJS.ProcessEnv,
  extra: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const { BACKUP_AGENT_TOKEN: _token, REDIS_URL: _redis, ...rest } = env;
  return { PGHOST: 'postgres', PGUSER: 'app', PGDATABASE: 'app', ...rest, ...extra };
}
