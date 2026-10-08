import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

export const RESTORE_PHASES = [
  'verify',
  'pre-backup',
  'maintenance',
  'db',
  'migrate',
  'storage',
  'redis',
  'done',
] as const;
export type RestorePhase = (typeof RESTORE_PHASES)[number];
export type Phase = RestorePhase | 'backup';
/** Фазы 3–7: пока восстановление на одной из них, флаг cr:maintenance должен стоять. */
export const MAINTENANCE_PHASES: readonly Phase[] = [
  'maintenance',
  'db',
  'migrate',
  'storage',
  'redis',
];
/** Фазы 4–7: база уже могла измениться — сбой ведёт в «требуется восстановление». */
export const DB_PHASES: readonly Phase[] = ['db', 'migrate', 'storage', 'redis'];

export interface Operation {
  id: string;
  type: 'backup' | 'restore';
  /** cron | логин | recovery-code */
  requestedBy: string;
  /** Что восстанавливается (для restore). */
  backup: string | null;
  /** pre-restore-* этого восстановления (или исходного, если это повтор по коду). */
  preRestore: string | null;
  /** Повтор по коду: исходный бэкап, из которого восстанавливали. */
  recoveryOf: string | null;
  maintenanceStartedAt: string | null;
  phase: Phase;
  status: 'running' | 'succeeded' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

/** «Требуется восстановление» (§26.4). Кода здесь нет — только его sha256. */
export interface RecoveryState {
  codeHash: string;
  attempts: number;
  backup: string;
  preRestore: string | null;
  phase: RestorePhase;
  startedAt: string;
}

export interface AgentState {
  operation: Operation | null;
  recovery: RecoveryState | null;
}

export interface StateStore {
  read(): Promise<AgentState>;
  write(s: AgentState): Promise<void>;
  /** Неразбираемый state.json переименовывается в state.json.corrupt-<время>; возвращает новое имя. */
  quarantine(): Promise<string | null>;
}

export const emptyState = (): AgentState => ({ operation: null, recovery: null });

export const RESOLVED_EXTERNALLY =
  'восстановление завершено вручную (resolved externally): scripts/restore.sh';

/**
 * <dir>/state.json. Запись атомарна: JSON во временный файл рядом, fsync и rename — после сбоя на диске
 * либо прежнее, либо новое состояние. Записи одного процесса идут строго по очереди.
 */
export function fileStateStore(dir: string): StateStore {
  const path = join(dir, 'state.json');
  let chain: Promise<unknown> = Promise.resolve();
  return {
    async read() {
      let text: string;
      try {
        text = await readFile(path, 'utf8');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
        throw e;
      }
      return { ...emptyState(), ...(JSON.parse(text) as Partial<AgentState>) };
    },
    async quarantine() {
      const name = `state.json.corrupt-${new Date().toISOString().replaceAll(':', '-')}`;
      try {
        await rename(path, join(dir, name));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw e;
      }
      return name;
    },
    write(s) {
      const json = JSON.stringify(s, null, 2);
      const job = chain.then(async () => {
        await mkdir(dir, { recursive: true });
        const tmp = `${path}.tmp`;
        // fsync до rename: после сбоя питания под именем state.json не окажется пустой файл.
        const fh = await open(tmp, 'w');
        try {
          await fh.writeFile(json);
          await fh.sync();
        } finally {
          await fh.close();
        }
        await rename(tmp, path);
      });
      chain = job.catch(() => {});
      return job;
    },
  };
}

/**
 * scripts/restore.sh перед запуском агента (§26.4): незавершённая операция и состояние
 * «требуется восстановление» помечаются failed (resolved externally) — агент больше не включает
 * обслуживание. true — состояние изменено.
 */
export async function resolveExternally(store: StateStore, now = new Date()): Promise<boolean> {
  let s: AgentState;
  try {
    s = await store.read();
  } catch {
    await store.write(emptyState());
    return true;
  }
  const op = s.operation;
  if (!(op?.status === 'running' || s.recovery)) return false;
  if (op) {
    op.status = 'failed';
    op.error = RESOLVED_EXTERNALLY;
    op.finishedAt ??= now.toISOString();
  }
  s.recovery = null;
  await store.write(s);
  return true;
}
