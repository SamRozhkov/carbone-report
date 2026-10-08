import { spawn } from 'node:child_process';

export type Release = () => Promise<void>;

export interface FileLock {
  /** null — замок занят другим процессом. */
  tryAcquire(): Promise<Release | null>;
}

export const LOCK_BUSY_EXIT = 75;

/**
 * Держатель замка: открывает файл на fd 9, берёт flock без ожидания и живёт, пока открыт его stdin.
 * Агент отпускает замок, закрывая stdin. Если агент умер, pipe закрывается сам: cat завершается,
 * fd закрывается, и замок снимается. Тот же файл и тот же код 75 у `entrypoint.sh now`.
 */
export const FLOCK_HOLDER_SCRIPT = `exec 9>>"$1"; flock -n 9 || exit ${LOCK_BUSY_EXIT}; echo locked; exec cat >/dev/null`;

export function flockFile(path: string): FileLock {
  return {
    tryAcquire: () =>
      new Promise((resolve, reject) => {
        const child = spawn('sh', ['-c', FLOCK_HOLDER_SCRIPT, 'sh', path], {
          stdio: ['pipe', 'pipe', 'inherit'],
        });
        let settled = false;
        const exited = new Promise<void>((r) => child.once('exit', () => r()));
        child.stdout.once('data', () => {
          settled = true;
          resolve(async () => {
            child.stdin.end();
            await exited;
          });
        });
        child.once('error', (e) => {
          if (!settled) {
            settled = true;
            reject(e);
          }
        });
        child.once('exit', (code) => {
          if (settled) return;
          settled = true;
          if (code === LOCK_BUSY_EXIT) resolve(null);
          else reject(new Error(`flock: код ${code}`));
        });
      }),
  };
}
