import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flockFile, FLOCK_HOLDER_SCRIPT, LOCK_BUSY_EXIT } from './lock';

const hasFlock = spawnSync('sh', ['-c', 'command -v flock']).status === 0;
/** Как `entrypoint.sh now`: тот же файл, тот же код 75. */
const shellTry = (path: string) =>
  spawnSync('sh', ['-c', 'exec 9>>"$1"; flock -n 9 || exit 75', 'sh', path]).status;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lock-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe.skipIf(!hasFlock)('flockFile', () => {
  it('второй захват — null; после освобождения замок свободен', async () => {
    const lock = flockFile(join(dir, '.op.lock'));
    const release = await lock.tryAcquire();
    expect(release).not.toBeNull();
    expect(await lock.tryAcquire()).toBeNull();
    await release!();
    const again = await lock.tryAcquire();
    expect(again).not.toBeNull();
    await again!();
  });

  it('замок держит и shell-скрипт через тот же файл (entrypoint.sh now)', async () => {
    const path = join(dir, '.op.lock');
    const release = await flockFile(path).tryAcquire();
    expect(shellTry(path)).toBe(LOCK_BUSY_EXIT);
    await release!();
    expect(shellTry(path)).toBe(0);
  });

  it('замок снимается, когда умер процесс-владелец (stdin держателя закрылся)', async () => {
    const path = join(dir, '.op.lock');
    // Отдельный node берёт замок тем же держателем и завершается, не отпуская его.
    const child = spawnSync(process.execPath, [
      '-e',
      `const c = require('node:child_process').spawn('sh', ['-c', ${JSON.stringify(FLOCK_HOLDER_SCRIPT)}, 'sh', ${JSON.stringify(path)}], { stdio: ['pipe', 'pipe', 'inherit'] });
       c.stdout.once('data', () => process.exit(0));`,
    ]);
    expect(child.status).toBe(0);
    let status = shellTry(path);
    for (let i = 0; i < 40 && status !== 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
      status = shellTry(path);
    }
    expect(status).toBe(0);
  });
});
