import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BackupAgent, type MaintenanceFlag, type Steps } from './agent';
import type { FileLock } from './lock';
import { fileOpLogs, type OpLogs } from './oplog';
import { hashCode, MAX_ATTEMPTS } from './recovery';
import {
  fileStateStore,
  RESOLVED_EXTERNALLY,
  type AgentState,
  type Operation,
  type StateStore,
} from './state';

const B = '2026-10-08T03-00-00Z';
const PRE = 'pre-restore-2026-10-08T10-00-00Z';
const CODE_RE = /^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/;

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

const freeLock = (): FileLock => ({ tryAcquire: async () => async () => {} });
const heldLock = (): FileLock => ({ tryAcquire: async () => null });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Flag = MaintenanceFlag | null;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function setup(
  opts: {
    steps?: Partial<Steps>;
    lock?: FileLock;
    state?: AgentState;
    reassertMs?: number;
    rawState?: string;
    logs?: OpLogs;
    warnings?: string[];
  } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-'));
  const store = fileStateStore(dir);
  if (opts.state) await store.write(opts.state);
  if (opts.rawState !== undefined) await writeFile(join(dir, 'state.json'), opts.rawState);
  const writes: AgentState[] = [];
  const spyStore: StateStore = {
    read: () => store.read(),
    quarantine: () => store.quarantine(),
    write: async (s) => {
      writes.push(structuredClone(s));
      await store.write(s);
    },
  };
  const calls: string[] = [];
  const flags: Flag[] = [];
  const steps: Steps = {
    backup: async () => void calls.push('backup'),
    verify: async (b) => void calls.push(`verify ${b}`),
    preBackup: async () => {
      calls.push('pre-backup');
      return PRE;
    },
    terminateApi: async () => void calls.push('terminate'),
    restoreDb: async (b) => void calls.push(`db ${b}`),
    migrate: async () => void calls.push('migrate'),
    restoreStorage: async (b) => void calls.push(`storage ${b}`),
    flushRedis: async () => void calls.push('redis'),
    setFlag: async (f) => void flags.push(f),
    clearFlag: async () => void flags.push(null),
    ...opts.steps,
  };
  const codes: string[] = [];
  const agent = new BackupAgent({
    steps,
    store: spyStore,
    lock: opts.lock ?? freeLock(),
    logs: opts.logs ?? fileOpLogs(join(dir, 'logs')),
    printCode: (c) => codes.push(c),
    log: (l) => void opts.warnings?.push(l),
    reassertMs: opts.reassertMs ?? 60_000,
  });
  await agent.init();
  cleanups.push(async () => {
    agent.close();
    await agent.idle();
    await rm(dir, { recursive: true, force: true });
  });
  return { agent, dir, store, writes, calls, flags, codes };
}

const restoreOp = (over: Partial<Operation>): Operation => ({
  id: 'old',
  type: 'restore',
  requestedBy: 'admin',
  backup: B,
  preRestore: PRE,
  recoveryOf: null,
  maintenanceStartedAt: '2026-10-08T10:00:05.000Z',
  phase: 'verify',
  status: 'running',
  startedAt: '2026-10-08T10:00:00.000Z',
  finishedAt: null,
  error: null,
  ...over,
});

const recoveryState = (code: string) => ({
  codeHash: hashCode(code),
  attempts: 0,
  backup: B,
  preRestore: PRE,
  phase: 'storage' as const,
  startedAt: '2026-10-08T10:00:05.000Z',
});

describe('BackupAgent: бэкап', () => {
  it('успех: операция succeeded, кто запустил — в операции и журнале', async () => {
    const t = await setup();
    const r = await t.agent.startBackup('admin');
    expect(r).toHaveProperty('operationId');
    await t.agent.idle();
    const op = await t.agent.operation();
    expect(op).toMatchObject({
      type: 'backup',
      requestedBy: 'admin',
      status: 'succeeded',
      recovery: null,
    });
    expect(op!.log.join('\n')).toContain('запустил admin');
    expect(t.calls).toEqual(['backup']);
  });

  it('сбой скрипта: failed с текстом ошибки', async () => {
    const t = await setup({
      steps: { backup: async () => Promise.reject(new Error('backup.sh: ошибка (pg_dump)')) },
    });
    await t.agent.startBackup('cron');
    await t.agent.idle();
    expect(await t.agent.operation()).toMatchObject({
      status: 'failed',
      error: 'backup.sh: ошибка (pg_dump)',
    });
  });

  it('одновременные запросы: второй получает busy с типом и временем первой операции', async () => {
    const gate = deferred();
    const t = await setup({ steps: { backup: () => gate.promise } });
    const [a, b] = await Promise.all([
      t.agent.startBackup('admin'),
      t.agent.startRestore(B, 'admin'),
    ]);
    expect(a).toHaveProperty('operationId');
    expect(b).toEqual({ busy: { type: 'backup', startedAt: expect.any(String) } });
    gate.resolve();
    await t.agent.idle();
  });

  it('flock занят другим процессом (ручной now) — busy без времени', async () => {
    const t = await setup({ lock: heldLock() });
    expect(await t.agent.startBackup('cron')).toEqual({
      busy: { type: 'backup', startedAt: null },
    });
    expect(await t.agent.operation()).toBeNull();
  });
});

describe('BackupAgent: восстановление', () => {
  it('успех: фазы по порядку, каждая записана в state.json; флаг на фазах 3–7 и снят в конце', async () => {
    const t = await setup();
    await t.agent.startRestore(B, 'admin');
    await t.agent.idle();
    const phases = t.writes.map((s) => s.operation?.phase).filter((p, i, a) => p && p !== a[i - 1]);
    expect(phases).toEqual([
      'verify',
      'pre-backup',
      'maintenance',
      'db',
      'migrate',
      'storage',
      'redis',
      'done',
    ]);
    expect(t.calls).toEqual([
      `verify ${B}`,
      'pre-backup',
      'terminate',
      `db ${B}`,
      'migrate',
      `storage ${B}`,
      'redis',
    ]);
    expect(t.flags.map((f) => f?.phase ?? null)).toEqual([
      null,
      'maintenance',
      'db',
      'migrate',
      'storage',
      'redis',
      null,
    ]);
    expect(t.flags[1]).toEqual({ phase: 'maintenance', startedAt: expect.any(String), backup: B });
    const op = await t.agent.operation();
    expect(op).toMatchObject({
      status: 'succeeded',
      phase: 'done',
      preRestore: PRE,
      recovery: null,
    });
    expect(t.codes).toEqual([]);
  });

  it('сбой verify: ничего не меняется, флаг не ставится, pre-backup не делается', async () => {
    const t = await setup({
      steps: {
        verify: async () =>
          Promise.reject(new Error('бэкап создан более новой версией приложения')),
      },
    });
    await t.agent.startRestore(B, 'admin');
    await t.agent.idle();
    expect(await t.agent.operation()).toMatchObject({
      status: 'failed',
      phase: 'verify',
      error: 'бэкап создан более новой версией приложения',
      recovery: null,
    });
    expect(t.calls).toEqual([]);
    expect(t.flags.filter(Boolean)).toEqual([]);
  });

  it('сбой pre-backup: восстановление отменено до обслуживания', async () => {
    const t = await setup({
      steps: { preBackup: async () => Promise.reject(new Error('backup.sh: код 1')) },
    });
    await t.agent.startRestore(B, 'admin');
    await t.agent.idle();
    expect(await t.agent.operation()).toMatchObject({
      status: 'failed',
      phase: 'pre-backup',
      recovery: null,
    });
    expect(t.flags.filter(Boolean)).toEqual([]);
  });

  it('флаг не записался (Redis недоступен) — отмена до замены базы, флаг снимается', async () => {
    const t = await setup({
      steps: { setFlag: async () => Promise.reject(new Error('Redis недоступен')) },
    });
    await t.agent.startRestore(B, 'admin');
    await t.agent.idle();
    expect(await t.agent.operation()).toMatchObject({
      status: 'failed',
      phase: 'maintenance',
      recovery: null,
    });
    expect(t.calls).not.toContain(`db ${B}`);
    expect(t.flags.at(-1)).toBeNull();
    expect(t.codes).toEqual([]);
  });

  it('сбой на фазе storage: флаг остаётся, «требуется восстановление», код напечатан', async () => {
    const t = await setup({
      steps: { restoreStorage: async () => Promise.reject(new Error('rclone: нет связи')) },
    });
    await t.agent.startRestore(B, 'admin');
    await t.agent.idle();
    expect(await t.agent.operation()).toMatchObject({
      status: 'failed',
      phase: 'storage',
      error: 'rclone: нет связи',
      recovery: { backup: B, preRestore: PRE },
    });
    expect(t.codes).toHaveLength(1);
    expect(t.codes[0]).toMatch(CODE_RE);
    expect(t.flags.at(-1)).toMatchObject({ phase: 'storage', backup: B });
  });

  it('код только в stdout: не в журнале операции и не в state.json (там sha256)', async () => {
    const t = await setup({
      steps: { migrate: async () => Promise.reject(new Error('миграция')) },
    });
    await t.agent.startRestore(B, 'admin');
    await t.agent.idle();
    const code = t.codes[0]!;
    const op = await t.agent.operation();
    expect(op!.log.join('\n')).not.toContain(code);
    const state = await readFile(join(t.dir, 'state.json'), 'utf8');
    expect(state).not.toContain(code);
    expect(state).not.toContain(code.replaceAll('-', ''));
    expect(state).toContain(hashCode(code));
  });

  it('в состоянии «требуется восстановление» бэкап и восстановление отклоняются', async () => {
    const t = await setup({
      state: {
        operation: restoreOp({ status: 'failed', phase: 'storage' }),
        recovery: recoveryState('AAAA-BBBB-CCCC'),
      },
    });
    expect(await t.agent.startBackup('cron')).toEqual({
      busy: { type: 'restore', startedAt: '2026-10-08T10:00:05.000Z' },
    });
    expect(await t.agent.startRestore(B, 'admin')).toEqual({
      busy: { type: 'restore', startedAt: '2026-10-08T10:00:05.000Z' },
    });
    expect(t.calls).toEqual([]);
  });
});

describe('BackupAgent: повтор по коду', () => {
  /** Восстановление, упавшее на фазе storage; ctl управляет следующими запусками шагов. */
  async function failed() {
    const ctl = { failStorage: true, redisGate: null as Promise<void> | null };
    const t = await setup({
      steps: {
        restoreStorage: async (b) => {
          t.calls.push(`storage ${b}`);
          if (ctl.failStorage) throw new Error('rclone: нет связи');
        },
        flushRedis: async () => {
          t.calls.push('redis');
          if (ctl.redisGate) await ctl.redisGate;
        },
      },
    });
    await t.agent.startRestore(B, 'admin');
    await t.agent.idle();
    return { ...t, ctl };
  }

  it('нет состояния «требуется восстановление» — no-recovery', async () => {
    const t = await setup();
    expect(await t.agent.recover('AAAA-BBBB-CCCC', 'same')).toEqual({ error: 'no-recovery' });
  });

  it('неверный код — bad-code; после 5 неверных код сгорает и печатается новый', async () => {
    const t = await failed();
    const first = t.codes[0]!;
    for (let i = 1; i <= 4; i++)
      expect(await t.agent.recover('AAAA-AAAA-AAAA', 'same')).toEqual({
        error: 'bad-code',
        burned: false,
      });
    expect(await t.agent.recover('AAAA-AAAA-AAAA', 'same')).toEqual({
      error: 'bad-code',
      burned: true,
    });
    expect(t.codes).toHaveLength(2);
    expect(t.codes[1]).not.toBe(first);
    expect(await t.agent.recover(first, 'same')).toEqual({ error: 'bad-code', burned: false });
  });

  it('верный код, цель same: с фазы maintenance без verify и pre-backup; успех снимает флаг и состояние', async () => {
    const t = await failed();
    t.ctl.failStorage = false;
    t.calls.length = 0;
    const r = await t.agent.recover(t.codes[0]!.toLowerCase(), 'same');
    expect(r).toHaveProperty('operationId');
    await t.agent.idle();
    expect(t.calls).toEqual(['terminate', `db ${B}`, 'migrate', `storage ${B}`, 'redis']);
    expect(await t.agent.operation()).toMatchObject({
      status: 'succeeded',
      requestedBy: 'recovery-code',
      recovery: null,
    });
    expect(t.flags.at(-1)).toBeNull();
    expect(await t.agent.startBackup('admin')).toHaveProperty('operationId');
    await t.agent.idle();
  });

  it('цель pre-restore восстанавливает бэкап до восстановления', async () => {
    const t = await failed();
    t.ctl.failStorage = false;
    t.calls.length = 0;
    await t.agent.recover(t.codes[0]!, 'pre-restore');
    await t.agent.idle();
    expect(t.calls).toContain(`db ${PRE}`);
    expect(await t.agent.operation()).toMatchObject({ status: 'succeeded', backup: PRE });
  });

  it('повтор снова упал — новый код, цели прежние', async () => {
    const t = await failed();
    await t.agent.recover(t.codes[0]!, 'pre-restore');
    await t.agent.idle();
    expect(t.codes).toHaveLength(2);
    expect(t.codes[1]).not.toBe(t.codes[0]);
    expect((await t.agent.operation())!.recovery).toEqual({ backup: B, preRestore: PRE });
  });

  it('пока идёт повтор, recovery в операции не показывается, а новый повтор — busy', async () => {
    const gate = deferred();
    const t = await failed();
    t.ctl.failStorage = false;
    t.ctl.redisGate = gate.promise;
    const code = t.codes[0]!;
    await t.agent.recover(code, 'same');
    await sleep(20);
    expect((await t.agent.operation())!.recovery).toBeNull();
    expect(await t.agent.recover(code, 'same')).toMatchObject({ busy: { type: 'restore' } });
    gate.resolve();
    await t.agent.idle();
  });
});

describe('BackupAgent: рестарт и флаг', () => {
  it('рестарт на фазе pre-backup: операция failed, флаг снят, кода нет', async () => {
    const t = await setup({
      state: { operation: restoreOp({ phase: 'pre-backup' }), recovery: null },
    });
    expect(await t.agent.operation()).toMatchObject({
      status: 'failed',
      error: 'прервано перезапуском агента',
      recovery: null,
    });
    expect(t.flags).toEqual([null]);
    expect(t.codes).toEqual([]);
  });

  it('рестарт на фазе migrate: требуется восстановление, флаг на месте, новый код', async () => {
    const t = await setup({
      state: { operation: restoreOp({ phase: 'migrate' }), recovery: null },
    });
    expect(await t.agent.operation()).toMatchObject({
      status: 'failed',
      recovery: { backup: B, preRestore: PRE },
    });
    expect(t.codes).toHaveLength(1);
    expect(t.flags).toEqual([
      { phase: 'migrate', startedAt: '2026-10-08T10:00:05.000Z', backup: B },
    ]);
  });

  it('рестарт посреди бэкапа: failed', async () => {
    const t = await setup({
      state: {
        operation: restoreOp({ type: 'backup', phase: 'backup', backup: null }),
        recovery: null,
      },
    });
    expect(await t.agent.operation()).toMatchObject({
      status: 'failed',
      error: 'прервано перезапуском агента',
    });
    expect(t.flags).toEqual([null]);
  });

  it('рестарт в состоянии «требуется восстановление»: прежний код заменён новым', async () => {
    const t = await setup({
      state: {
        operation: restoreOp({ status: 'failed', phase: 'storage' }),
        recovery: recoveryState('AAAA-BBBB-CCCC'),
      },
    });
    expect(t.codes).toHaveLength(1);
    expect(await t.agent.recover('AAAA-BBBB-CCCC', 'same')).toEqual({
      error: 'bad-code',
      burned: false,
    });
  });

  it('resolved externally: агент не возвращает флаг', async () => {
    const t = await setup({
      state: {
        operation: restoreOp({ status: 'failed', phase: 'storage', error: RESOLVED_EXTERNALLY }),
        recovery: null,
      },
      reassertMs: 20,
    });
    await sleep(100);
    expect(t.flags.filter(Boolean)).toEqual([]);
  });

  it('флаг повторяется каждые reassertMs, пока требуется восстановление', async () => {
    const t = await setup({
      state: {
        operation: restoreOp({ status: 'failed', phase: 'storage' }),
        recovery: recoveryState('AAAA-BBBB-CCCC'),
      },
      reassertMs: 20,
    });
    await sleep(150);
    expect(t.flags.filter((f) => f?.phase === 'storage').length).toBeGreaterThanOrEqual(4);
  });

  it('повтор флага не возвращает его после снятия', async () => {
    // Медленный SET: повтор таймера ещё в очереди, когда восстановление снимает флаг.
    let slowSets = 0;
    const flagsSeen: Flag[] = [];
    const t = await setup({
      reassertMs: 5,
      state: {
        operation: restoreOp({ status: 'failed', phase: 'storage' }),
        recovery: recoveryState('AAAA-BBBB-CCCC'),
      },
      steps: {
        setFlag: async (f) => {
          slowSets++;
          await sleep(3);
          flagsSeen.push(f);
        },
        clearFlag: async () => void flagsSeen.push(null),
      },
    });
    await t.agent.recover(t.codes[0]!, 'same');
    await t.agent.idle();
    await sleep(60);
    expect(slowSets).toBeGreaterThan(0);
    expect(flagsSeen.at(-1)).toBeNull();
    const after = flagsSeen.length;
    await sleep(60);
    expect(flagsSeen.slice(after).every((f) => f === null)).toBe(true);
  });

  it('DEL не прошёл — таймер снимает флаг позже', async () => {
    let failDel = true;
    const dels: string[] = [];
    const t = await setup({
      reassertMs: 20,
      steps: {
        clearFlag: async () => {
          dels.push(failDel ? 'fail' : 'ok');
          if (failDel) throw new Error('Redis недоступен');
        },
        terminateApi: async () => Promise.reject(new Error('postgres недоступен')),
      },
    });
    dels.length = 0;
    await t.agent.startRestore(B, 'admin');
    await t.agent.idle();
    expect(dels).toContain('fail');
    failDel = false;
    await sleep(80);
    expect(dels.at(-1)).toBe('ok');
    const n = dels.length;
    await sleep(80);
    expect(dels.length).toBe(n);
  });
});

describe('BackupAgent: сбои повтора и повреждённое состояние', () => {
  it('повтор по коду упал на фазе maintenance (флаг не записался) — новый код, старый не работает', async () => {
    const ctl = { failFlag: false };
    const t = await setup({
      steps: {
        restoreStorage: async () => Promise.reject(new Error('rclone: нет связи')),
        setFlag: async (f) => {
          if (ctl.failFlag) throw new Error('Redis недоступен');
          t.flags.push(f);
        },
      },
    });
    await t.agent.startRestore(B, 'admin');
    await t.agent.idle();
    const first = t.codes[0]!;
    ctl.failFlag = true;
    expect(await t.agent.recover(first, 'same')).toHaveProperty('operationId');
    await t.agent.idle();
    expect(await t.agent.operation()).toMatchObject({
      status: 'failed',
      phase: 'maintenance',
      recovery: { backup: B, preRestore: PRE },
    });
    expect(t.codes).toHaveLength(2);
    expect(t.codes[1]).toMatch(CODE_RE);
    expect(t.codes[1]).not.toBe(first);
    expect(await t.agent.recover(first, 'same')).toEqual({ error: 'bad-code', burned: false });
    ctl.failFlag = false;
    expect(await t.agent.recover(t.codes[1]!, 'same')).toHaveProperty('operationId');
    await t.agent.idle();
  });

  it('рестарт посреди повтора на фазе maintenance — новый код вместо прежнего', async () => {
    const t = await setup({
      state: {
        operation: restoreOp({ phase: 'maintenance', recoveryOf: B, requestedBy: 'recovery-code' }),
        recovery: recoveryState('AAAA-BBBB-CCCC'),
      },
    });
    expect(t.codes).toHaveLength(1);
    expect(await t.agent.recover('AAAA-BBBB-CCCC', 'same')).toEqual({
      error: 'bad-code',
      burned: false,
    });
    expect((await t.agent.operation())!.recovery).toEqual({ backup: B, preRestore: PRE });
  });

  it('цель pre-restore без бэкапа до восстановления — bad-target, код не расходуется', async () => {
    const t = await setup({
      state: {
        operation: restoreOp({ status: 'failed', phase: 'storage', preRestore: null }),
        recovery: { ...recoveryState('AAAA-BBBB-CCCC'), preRestore: null },
      },
    });
    const code = t.codes.splice(0)[0]!; // при старте в этом состоянии код заменяется новым
    for (let i = 0; i < MAX_ATTEMPTS + 1; i++) {
      expect(await t.agent.recover('AAAA-AAAA-AAAA', 'pre-restore')).toEqual({
        error: 'bad-target',
      });
      expect(await t.agent.recover(code, 'pre-restore')).toEqual({ error: 'bad-target' });
    }
    expect(t.codes).toEqual([]);
    // Счётчик не менялся: после неверного кода с допустимой целью burned всё ещё false.
    expect(await t.agent.recover('AAAA-AAAA-AAAA', 'same')).toEqual({
      error: 'bad-code',
      burned: false,
    });
    expect(await t.agent.recover(code, 'same')).toHaveProperty('operationId');
    await t.agent.idle();
  });

  it('повреждённый state.json при старте: предупреждение, файл переименован, пустое состояние', async () => {
    const warnings: string[] = [];
    const t = await setup({ rawState: '{"operation":', warnings });
    expect(await t.agent.operation()).toBeNull();
    expect(warnings.join('\n')).toContain('state.json');
    const files = await readdir(t.dir);
    const corrupt = files.filter((f) => f.startsWith('state.json.corrupt-'));
    expect(corrupt).toHaveLength(1);
    expect(await readFile(join(t.dir, corrupt[0]!), 'utf8')).toBe('{"operation":');
    expect(files).not.toContain('state.json');
    expect(await t.agent.startBackup('admin')).toHaveProperty('operationId');
    await t.agent.idle();
  });

  it('журнал операции не открылся — операция помечена failed и сохранена, ошибка проброшена', async () => {
    const logs: OpLogs = {
      open: async () => Promise.reject(new Error('диск переполнен')),
      tail: async () => [],
    };
    const t = await setup({ logs });
    await expect(t.agent.startBackup('admin')).rejects.toThrow('диск переполнен');
    expect(await t.agent.operation()).toMatchObject({ status: 'failed', error: 'диск переполнен' });
    expect((await t.store.read()).operation).toMatchObject({
      status: 'failed',
      error: 'диск переполнен',
    });
    expect(t.calls).toEqual([]);
  });
});
