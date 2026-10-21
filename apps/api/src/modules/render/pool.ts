import { Worker, type ResourceLimits } from 'node:worker_threads';

/** Опции рендера Carbone для потока. */
export interface RenderOptions {
  lang: string;
  timezone: string;
  /** Хосты для загрузки изображений по адресу (§32.2); пусто или нет — загрузка выключена. */
  imageUrlAllowlist?: string[];
  /** Тайм-аут загрузки одного изображения, мс. */
  imageUrlTimeoutMs?: number;
}

export interface RenderJob {
  /**
   * carbone (по умолчанию) — сборка отчёта; pdf — обработка готового PDF (§36.4), template — сам PDF;
   * sign — подготовка PDF к подписи (§39.4), template — сам PDF;
   * p12 — разбор .p12 (§39.8), template — файл, data — { password, now };
   * gost-prepare — штамп без поля подписи и хеш Стрибог (§42), template — PDF;
   * gost-verify — проверка подписи CAdES (§42.4), template — DER подписи.
   */
  kind?: 'carbone' | 'pdf' | 'sign' | 'p12' | 'gost-prepare' | 'gost-verify';
  template: Buffer;
  ext: string;
  data: unknown;
  options: RenderOptions;
  /** Дополнительные файлы задачи: для pdf — приложенные файлы в порядке data.attachments. */
  extra?: Uint8Array[];
}

/** Готовый отчёт и предупреждения рендера (например, изображение по адресу не загрузилось). */
export interface RenderResult {
  out: Buffer;
  warnings: string[];
  /** Метаданные задачи (JSON от потока): для p12 — сертификаты и сведения; для ГОСТ — хеш, итог проверки. */
  meta?: unknown;
}

export interface RenderPoolOptions {
  size: number;
  workerUrl: URL;
  execArgv?: string[];
  resourceLimits?: ResourceLimits;
  /** Срок до сигнала ready от потока, мс (по умолчанию 30 000); иначе поток пересоздаётся. */
  readyTimeoutMs?: number;
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

/** Ошибка шаблона: message — текст Carbone; field — поле формы (ошибка .p12, §39.8) или gost (§42.4). */
export class TemplateRenderError extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}

type Reply =
  | { ready: true }
  | { id: number; ok: true; out: Uint8Array; warnings?: string[]; meta?: string }
  | { id: number; ok: false; message: string; field?: string };

interface Task {
  id: number;
  job: RenderJob;
  /** JSON данных, сериализованный до постановки в очередь. */
  data: string;
  deadlineAt: number;
  resolve(result: RenderResult): void;
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
  /** Срок готовности потока: снимается по ready, retire и destroy. */
  readyTimer?: NodeJS.Timeout;
}

const BACKOFF_START_MS = 1000;
const BACKOFF_MAX_MS = 30_000;
const READY_TIMEOUT_MS = 30_000;

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

  run(job: RenderJob, deadlineAt: number): Promise<RenderResult> {
    return new Promise<RenderResult>((resolve, reject) => {
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
      clearTimeout(s.readyTimer);
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
    const readyMs = this.opts.readyTimeoutMs ?? READY_TIMEOUT_MS;
    clearTimeout(slot.readyTimer);
    slot.readyTimer = setTimeout(() => {
      // Только если слот всё ещё держит тот же поток, не приславший ready.
      if (slot.worker === worker && !slot.ready) {
        this.crash(slot, new Error(`поток рендера не готов за ${readyMs} мс`));
      }
    }, readyMs);
    worker.on('message', (m: Reply) => {
      if ('ready' in m) {
        clearTimeout(slot.readyTimer);
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
    const extra = (task.job.extra ?? []).map((b) => new Uint8Array(b));
    worker.postMessage(
      {
        id: task.id,
        kind: task.job.kind ?? 'carbone',
        template,
        ext: task.job.ext,
        data: task.data,
        options: task.job.options,
        extra,
      },
      [template.buffer, ...extra.map((e) => e.buffer as ArrayBuffer)],
    );
    task.timer = setTimeout(
      () => this.timeout(slot, task),
      Math.max(0, task.deadlineAt - Date.now()),
    );
  }

  private finish(slot: Slot, m: Exclude<Reply, { ready: true }>): void {
    const task = slot.task;
    if (!task || task.id !== m.id) return;
    clearTimeout(task.timer);
    slot.task = null;
    if (m.ok)
      task.resolve({
        out: Buffer.from(m.out.buffer, m.out.byteOffset, m.out.byteLength),
        warnings: Array.isArray(m.warnings) ? m.warnings : [],
        ...(typeof m.meta === 'string' ? { meta: JSON.parse(m.meta) as unknown } : {}),
      });
    else task.reject(new TemplateRenderError(m.message, m.field));
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
    clearTimeout(slot.readyTimer);
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
