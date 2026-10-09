import { Worker, type ResourceLimits } from 'node:worker_threads';

export interface RenderJob {
  template: Buffer;
  ext: string;
  data: unknown;
  options: { lang: string; timezone: string };
}

export interface RenderPoolOptions {
  size: number;
  workerUrl: URL;
  execArgv?: string[];
  resourceLimits?: ResourceLimits;
  /** Аварийное завершение потока (в том числе без задачи) — для журнала. */
  onCrash?(err: unknown, ctx?: { hadTask: boolean; beforeReady: boolean }): void;
}

/** Срок рендера истёк — в очереди или в потоке. */
export class RenderTimeoutError extends Error {
  constructor() {
    super('превышено время ожидания');
  }
}

/** Поток завершился аварийно или пул остановлен. */
export class RenderCrashError extends Error {}

/** Ошибка шаблона: message — текст Carbone. */
export class TemplateRenderError extends Error {}

type Reply =
  | { ready: true }
  | { id: number; ok: true; out: Uint8Array }
  | { id: number; ok: false; message: string };

interface Task {
  id: number;
  job: RenderJob;
  /** JSON данных, сериализованный до постановки в очередь. */
  data: string;
  deadlineAt: number;
  resolve(out: Buffer): void;
  reject(err: Error): void;
  timer?: NodeJS.Timeout;
}

interface Slot {
  /** null — поток упал, пересоздание отложено (backoff). */
  worker: Worker | null;
  /** Поток прислал { ready: true }: модули загружены, можно отдавать задачи. */
  ready: boolean;
  task: Task | null;
  /** Текущая задержка пересоздания, мс (0 — без задержки). */
  backoff: number;
  respawnTimer?: NodeJS.Timeout;
}

const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 30_000;

/**
 * Пул worker_threads для Carbone: сборка отчёта не блокирует основной поток API.
 * Поток, не уложившийся в срок, останавливается и пересоздаётся; срок тикает и в очереди.
 * Поток, который умирает до сигнала ready, пересоздаётся с нарастающей паузой (1 с … 30 с).
 */
export class RenderPool {
  private slots: Slot[] = [];
  private readonly queue: Task[] = [];
  private seq = 0;
  private closed = false;

  constructor(private readonly opts: RenderPoolOptions) {
    for (let i = 0; i < opts.size; i++) {
      const slot: Slot = { worker: null, ready: false, task: null, backoff: 0 };
      this.slots.push(slot);
      this.spawn(slot);
    }
  }

  run(job: RenderJob, deadlineAt: number): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      if (this.closed) return reject(new RenderCrashError('пул рендера остановлен'));
      const wait = deadlineAt - Date.now();
      if (wait <= 0) return reject(new RenderTimeoutError());
      // Сериализуем сразу: BigInt/циклы не должны занимать поток и падать внутри postMessage.
      let data: string | undefined;
      try {
        data = JSON.stringify(job.data);
      } catch (err) {
        return reject(
          new TemplateRenderError(
            `данные отчёта не сериализуются в JSON: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      }
      if (typeof data !== 'string') {
        return reject(new TemplateRenderError('данные отчёта не сериализуются в JSON'));
      }
      const task: Task = { id: ++this.seq, job, data, deadlineAt, resolve, reject };
      task.timer = setTimeout(() => this.expireQueued(task), wait);
      this.queue.push(task);
      this.dispatch();
    });
  }

  async destroy(): Promise<void> {
    this.closed = true;
    const stopped = new RenderCrashError('пул рендера остановлен');
    for (const t of this.queue.splice(0)) {
      clearTimeout(t.timer);
      t.reject(stopped);
    }
    const slots = this.slots;
    this.slots = [];
    for (const s of slots) {
      clearTimeout(s.respawnTimer);
      if (s.task) {
        clearTimeout(s.task.timer);
        s.task.reject(stopped);
        s.task = null;
      }
    }
    await Promise.all(slots.map((s) => s.worker?.terminate()));
  }

  private spawn(slot: Slot): void {
    const worker = new Worker(this.opts.workerUrl, {
      execArgv: this.opts.execArgv,
      resourceLimits: this.opts.resourceLimits,
    });
    slot.worker = worker;
    slot.ready = false;
    worker.on('message', (m: Reply) => {
      if ('ready' in m) {
        slot.ready = true;
        slot.backoff = 0;
        this.dispatch();
      } else this.finish(slot, m);
    });
    worker.on('error', (err) => this.crash(slot, err));
    worker.on('exit', (code) =>
      this.crash(slot, new Error(`поток рендера завершился с кодом ${code}`)),
    );
  }

  private dispatch(): void {
    for (const slot of this.slots) {
      if (slot.task || !slot.worker || !slot.ready) continue;
      let task = this.queue.shift();
      // Просроченная задача поток не занимает.
      while (task && task.deadlineAt <= Date.now()) {
        clearTimeout(task.timer);
        task.reject(new RenderTimeoutError());
        task = this.queue.shift();
      }
      if (!task) return;
      this.start(slot, slot.worker, task);
    }
  }

  private start(slot: Slot, worker: Worker, task: Task): void {
    clearTimeout(task.timer);
    slot.task = task;
    // Всегда копия: шаблон вызывающего (в том числе из общего пула Node) не должен отсоединяться.
    const template = new Uint8Array(task.job.template);
    worker.postMessage(
      { id: task.id, template, ext: task.job.ext, data: task.data, options: task.job.options },
      [template.buffer],
    );
    task.timer = setTimeout(
      () => this.timeout(slot, task),
      Math.max(0, task.deadlineAt - Date.now()),
    );
  }

  private finish(slot: Slot, m: Reply): void {
    const task = slot.task;
    if (!task || task.id !== m.id) return;
    clearTimeout(task.timer);
    slot.task = null;
    if (m.ok) task.resolve(Buffer.from(m.out.buffer, m.out.byteOffset, m.out.byteLength));
    else task.reject(new TemplateRenderError(m.message));
    this.dispatch();
  }

  private timeout(slot: Slot, task: Task): void {
    if (slot.task !== task) return;
    slot.task = null;
    this.retire(slot);
    this.scheduleRespawn(slot, 0);
    task.reject(new RenderTimeoutError());
    this.dispatch();
  }

  private crash(slot: Slot, err: unknown): void {
    if (this.closed || !this.slots.includes(slot) || !slot.worker) return;
    const task = slot.task;
    slot.task = null;
    const beforeReady = !slot.ready;
    this.retire(slot);
    this.opts.onCrash?.(err, { hadTask: task !== null, beforeReady });
    this.scheduleRespawn(
      slot,
      beforeReady
        ? slot.backoff
          ? Math.min(slot.backoff * 2, BACKOFF_MAX_MS)
          : BACKOFF_START_MS
        : 0,
    );
    if (task) {
      clearTimeout(task.timer);
      task.reject(new RenderCrashError('поток рендера завершился аварийно'));
    }
    this.dispatch();
  }

  /** Останавливает поток слота; removeAllListeners — чтобы его exit не засчитался как авария. */
  private retire(slot: Slot): void {
    const worker = slot.worker;
    slot.worker = null;
    slot.ready = false;
    if (!worker) return;
    worker.removeAllListeners();
    worker.on('error', () => {});
    void worker.terminate();
  }

  private scheduleRespawn(slot: Slot, delay: number): void {
    slot.backoff = delay;
    if (delay === 0) {
      this.spawn(slot);
      return;
    }
    slot.respawnTimer = setTimeout(() => {
      if (this.closed || !this.slots.includes(slot)) return;
      this.spawn(slot);
      this.dispatch();
    }, delay);
  }

  private expireQueued(task: Task): void {
    const i = this.queue.indexOf(task);
    if (i < 0) return;
    this.queue.splice(i, 1);
    task.reject(new RenderTimeoutError());
  }
}
