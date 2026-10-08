import { randomUUID } from 'node:crypto';
import type { FileLock, Release } from './lock';
import type { OpLog, OpLogs } from './oplog';
import { codeMatches, generateCode, hashCode, MAX_ATTEMPTS } from './recovery';
import type { Out } from './run';
import {
  DB_PHASES,
  emptyState,
  MAINTENANCE_PHASES,
  type AgentState,
  type Operation,
  type RestorePhase,
  type StateStore,
} from './state';

/** Значение cr:maintenance (§26.2). */
export interface MaintenanceFlag {
  phase: RestorePhase;
  startedAt: string;
  backup: string;
}

/** Шаги операций; реальные — createSteps (steps.ts), в юнит-тестах — подделки. */
export interface Steps {
  backup(out: Out): Promise<void>;
  verify(backup: string, out: Out): Promise<void>;
  /** Бэкап pre-restore-<время>; возвращает имя каталога. */
  preBackup(out: Out): Promise<string>;
  /** Пауза terminateDelayMs, затем pg_terminate_backend сессий application_name = 'api'. */
  terminateApi(out: Out): Promise<void>;
  restoreDb(backup: string, out: Out): Promise<void>;
  migrate(out: Out): Promise<void>;
  restoreStorage(backup: string, out: Out): Promise<void>;
  flushRedis(out: Out): Promise<void>;
  setFlag(flag: MaintenanceFlag): Promise<void>;
  clearFlag(): Promise<void>;
}

export interface Busy {
  type: 'backup' | 'restore';
  /** null — замок держит другой процесс (ручной `docker compose run backup now`). */
  startedAt: string | null;
}
export type StartResult = { operationId: string } | { busy: Busy };
export type RecoverResult =
  | StartResult
  | { error: 'no-recovery' }
  /** Цель pre-restore, а бэкапа до восстановления нет. Код не расходуется. */
  | { error: 'bad-target' }
  | { error: 'bad-code'; burned: boolean };

export interface OperationView extends Operation {
  log: string[];
  recovery: { backup: string; preRestore: string | null } | null;
}

export interface AgentDeps {
  steps: Steps;
  store: StateStore;
  lock: FileLock;
  logs: OpLogs;
  /** Только stdout контейнера (docker compose logs backup), никогда — журнал операции. */
  printCode(code: string): void;
  /** Журнал агента (stdout). */
  log(line: string): void;
  reassertMs: number;
  now?: () => Date;
  newId?: () => string;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const INTERRUPTED = 'прервано перезапуском агента';

export class BackupAgent {
  private state: AgentState = emptyState();
  private running: { type: 'backup' | 'restore'; startedAt: string } | null = null;
  private current: Promise<void> = Promise.resolve();
  private flagChain: Promise<void> = Promise.resolve();
  /** Флаг мог остаться в Redis (последний SET или неудачный DEL). */
  private flagMaybeSet = true;
  private lastFlagWarn = -Infinity;
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly d: AgentDeps) {
    this.now = d.now ?? (() => new Date());
    this.newId = d.newId ?? randomUUID;
  }

  /** Чтение state.json, разбор прерванной операции (§26.2), снятие или возврат флага, таймер повтора. */
  async init(): Promise<void> {
    try {
      this.state = await this.d.store.read();
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
      const moved = await this.d.store.quarantine();
      this.d.log(
        `state.json повреждён (${errorText(e)}); сохранён как ${moved ?? 'state.json.corrupt-*'}, начинаем с пустого состояния`,
      );
      this.state = emptyState();
    }
    const op = this.state.operation;
    let code: string | null = null;
    if (op?.status === 'running') {
      this.finish(op, 'failed', INTERRUPTED);
      // Повтор по коду, прерванный на фазах 1–3, тоже получает новый код: прежний мог попасть в журнал контейнера.
      if (op.type === 'restore' && (DB_PHASES.includes(op.phase) || this.state.recovery))
        code = this.newRecovery(op);
      await this.save();
    } else if (this.state.recovery) {
      code = this.renewCode();
      await this.save();
      this.d.log('агент перезапущен в состоянии «требуется восстановление»: прежний код заменён');
    }
    if (code) this.d.printCode(code);
    await this.syncFlag(true);
    this.timer = setInterval(() => void this.syncFlag(false), this.d.reassertMs);
    this.timer.unref();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Конец текущей операции (тесты, остановка). */
  idle(): Promise<void> {
    return this.current;
  }

  startBackup(requestedBy: string): Promise<StartResult> {
    const blocked = this.recoveryBusy();
    if (blocked) return Promise.resolve(blocked);
    return this.start('backup', requestedBy, null, {}, (op, out) => this.runBackup(op, out));
  }

  startRestore(backup: string, requestedBy: string): Promise<StartResult> {
    const blocked = this.recoveryBusy();
    if (blocked) return Promise.resolve(blocked);
    return this.start('restore', requestedBy, backup, {}, (op, out) =>
      this.runRestore(op, out, true),
    );
  }

  async recover(code: string, target: 'same' | 'pre-restore'): Promise<RecoverResult> {
    if (this.running) return { busy: { ...this.running } };
    const rec = this.state.recovery;
    if (!rec) return { error: 'no-recovery' };
    // Цель проверяется до кода: ошибка запроса не должна сжигать попытки.
    const backup = target === 'same' ? rec.backup : rec.preRestore;
    if (!backup) return { error: 'bad-target' };
    if (!codeMatches(code, rec.codeHash)) {
      rec.attempts += 1;
      const burned = rec.attempts >= MAX_ATTEMPTS;
      const fresh = burned ? this.renewCode() : null;
      await this.save();
      if (fresh) {
        this.d.log(`${MAX_ATTEMPTS} неверных попыток: код восстановления заменён`);
        this.d.printCode(fresh);
      }
      return { error: 'bad-code', burned };
    }
    return this.start(
      'restore',
      'recovery-code',
      backup,
      { recoveryOf: rec.backup, preRestore: rec.preRestore },
      (op, out) => this.runRestore(op, out, false),
    );
  }

  async operation(): Promise<OperationView | null> {
    const op = this.state.operation;
    if (!op) return null;
    const rec = this.state.recovery;
    return {
      ...op,
      log: await this.d.logs.tail(op.id),
      recovery:
        op.status !== 'running' && rec ? { backup: rec.backup, preRestore: rec.preRestore } : null,
    };
  }

  private recoveryBusy(): { busy: Busy } | null {
    const rec = this.state.recovery;
    return rec ? { busy: { type: 'restore', startedAt: rec.startedAt } } : null;
  }

  private async start(
    type: 'backup' | 'restore',
    requestedBy: string,
    backup: string | null,
    extra: Partial<Operation>,
    body: (op: Operation, out: Out) => Promise<void>,
  ): Promise<StartResult> {
    if (this.running) return { busy: { ...this.running } };
    const startedAt = this.now().toISOString();
    // До первого await: одновременный второй запрос увидит занятость.
    this.running = { type, startedAt };
    let release: Release | null;
    try {
      release = await this.d.lock.tryAcquire();
    } catch (e) {
      this.running = null;
      throw e;
    }
    if (!release) {
      this.running = null;
      return { busy: { type: 'backup', startedAt: null } };
    }
    const op: Operation = {
      id: this.newId(),
      type,
      requestedBy,
      backup,
      preRestore: null,
      recoveryOf: null,
      maintenanceStartedAt: null,
      phase: type === 'backup' ? 'backup' : 'verify',
      status: 'running',
      startedAt,
      finishedAt: null,
      error: null,
      ...extra,
    };
    let log: OpLog;
    try {
      this.state.operation = op;
      await this.save();
      log = await this.d.logs.open(op.id);
    } catch (e) {
      // Операция уже записана как running: без этого она осталась бы running до рестарта агента.
      this.finish(op, 'failed', errorText(e));
      await this.save().catch(() => {});
      this.running = null;
      await release();
      throw e;
    }
    const out: Out = (line) => {
      log.write(line);
      this.d.log(line);
    };
    out(
      `операция ${op.id}: ${type === 'backup' ? 'бэкап' : `восстановление из ${backup}`}, запустил ${requestedBy}`,
    );
    const held = release;
    this.current = body(op, out)
      .catch((e) => this.d.log(`внутренняя ошибка операции: ${errorText(e)}`))
      .finally(async () => {
        await log.close();
        await held();
        this.running = null;
      });
    return { operationId: op.id };
  }

  private async runBackup(op: Operation, out: Out): Promise<void> {
    try {
      await this.d.steps.backup(out);
      this.finish(op, 'succeeded');
      out('бэкап завершён');
    } catch (e) {
      this.finish(op, 'failed', errorText(e));
      out(`ошибка: ${errorText(e)}`);
    }
    await this.save();
  }

  /** full = false — повтор по коду: с фазы maintenance, без verify и pre-backup (§26.4). */
  private async runRestore(op: Operation, out: Out, full: boolean): Promise<void> {
    const s = this.d.steps;
    const backup = op.backup!;
    try {
      if (full) {
        await this.phase(op, 'verify', out);
        await s.verify(backup, out);
        await this.phase(op, 'pre-backup', out);
        op.preRestore = await s.preBackup(out);
        await this.save();
      }
      op.maintenanceStartedAt = this.now().toISOString();
      await this.phase(op, 'maintenance', out);
      await this.syncFlag(true, true);
      await s.terminateApi(out);
      const rest: [RestorePhase, () => Promise<void>][] = [
        ['db', () => s.restoreDb(backup, out)],
        ['migrate', () => s.migrate(out)],
        ['storage', () => s.restoreStorage(backup, out)],
        ['redis', () => s.flushRedis(out)],
      ];
      for (const [phase, step] of rest) {
        await this.phase(op, phase, out);
        await this.syncFlag(true, true);
        await step();
      }
      op.phase = 'done';
      this.finish(op, 'succeeded');
      this.state.recovery = null;
      await this.save();
      out('восстановление завершено');
      await this.syncFlag(true);
    } catch (e) {
      const failedAt = op.phase;
      this.finish(op, 'failed', errorText(e));
      out(`ошибка на этапе ${failedAt}: ${errorText(e)}`);
      // Новый код при каждом сбое операции, начатой в состоянии «требуется восстановление» (§26.4),
      // в том числе при сбое повтора до замены базы.
      const code =
        DB_PHASES.includes(failedAt) || this.state.recovery ? this.newRecovery(op) : null;
      await this.save();
      if (code) {
        out(
          'восстановление не завершено: база частично заменена; код восстановления — в журнале контейнера (docker compose logs backup)',
        );
        this.d.printCode(code);
      }
      // Фазы 1–3: флаг снимается; 4–7: остаётся (состояние «требуется восстановление»).
      await this.syncFlag(true);
    }
  }

  private async phase(op: Operation, phase: RestorePhase, out: Out): Promise<void> {
    op.phase = phase;
    await this.save();
    out(`этап: ${phase}`);
  }

  private finish(op: Operation, status: 'succeeded' | 'failed', error: string | null = null): void {
    op.status = status;
    op.error = error;
    op.finishedAt = this.now().toISOString();
  }

  /** Новое состояние «требуется восстановление»; возвращает код (печатается после записи state.json). */
  private newRecovery(op: Operation): string {
    const code = generateCode();
    this.state.recovery = {
      codeHash: hashCode(code),
      attempts: 0,
      backup: op.recoveryOf ?? op.backup!,
      preRestore: op.preRestore,
      phase: op.phase as RestorePhase,
      startedAt: op.maintenanceStartedAt ?? op.startedAt,
    };
    return code;
  }

  private renewCode(): string {
    const code = generateCode();
    this.state.recovery!.codeHash = hashCode(code);
    this.state.recovery!.attempts = 0;
    return code;
  }

  private save(): Promise<void> {
    return this.d.store.write(this.state);
  }

  /** Каким должен быть флаг сейчас (§26.2: фазы 3–7 или «требуется восстановление»). */
  private desiredFlag(): MaintenanceFlag | null {
    const op = this.state.operation;
    if (op?.type === 'restore' && op.status === 'running' && MAINTENANCE_PHASES.includes(op.phase))
      return {
        phase: op.phase as RestorePhase,
        startedAt: op.maintenanceStartedAt ?? op.startedAt,
        backup: op.backup!,
      };
    const rec = this.state.recovery;
    return rec ? { phase: rec.phase, startedAt: rec.startedAt, backup: rec.backup } : null;
  }

  /**
   * Все записи флага — по очереди, значение вычисляется в момент записи: повтор, поставленный
   * в очередь до снятия флага, его не вернёт. strict — ошибку отдать вызывающему (переход фазы).
   */
  private syncFlag(force: boolean, strict = false): Promise<void> {
    const job = this.flagChain.then(async () => {
      const flag = this.desiredFlag();
      try {
        if (flag) {
          this.flagMaybeSet = true;
          await this.d.steps.setFlag(flag);
        } else if (force || this.flagMaybeSet) {
          await this.d.steps.clearFlag();
          this.flagMaybeSet = false;
        }
      } catch (e) {
        if (strict) throw e;
        const t = Date.now();
        if (t - this.lastFlagWarn >= 30_000) {
          this.lastFlagWarn = t;
          this.d.log(`не удалось обновить флаг обслуживания в Redis: ${errorText(e)}`);
        }
      }
    });
    this.flagChain = job.catch(() => {});
    return job;
  }
}
