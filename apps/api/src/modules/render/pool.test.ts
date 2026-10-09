import { afterEach, describe, expect, it } from 'vitest';
import { RenderCrashError, RenderPool, RenderTimeoutError, TemplateRenderError } from './pool';

const workerUrl = new URL('./test-workers/fake-render.mjs', import.meta.url);
const job = (mode: string, ms = 0) => ({
  template: Buffer.from('tpl'),
  ext: 'docx',
  data: { mode, ms },
  options: { lang: 'ru', timezone: 'Europe/Moscow' },
});
const soon = (ms: number) => Date.now() + ms;

let pool: RenderPool | undefined;
afterEach(async () => {
  await pool?.destroy();
  pool = undefined;
});

describe('RenderPool', () => {
  it('возвращает результат потока', async () => {
    pool = new RenderPool({ size: 1, workerUrl });
    expect((await pool.run(job('echo'), soon(5000))).toString()).toBe('tpl!');
  });

  it('ошибка шаблона — TemplateRenderError с текстом Carbone', async () => {
    pool = new RenderPool({ size: 1, workerUrl });
    await expect(pool.run(job('fail'), soon(5000))).rejects.toThrow(TemplateRenderError);
    await expect(pool.run(job('fail'), soon(5000))).rejects.toThrow('Formatter "x" does not exist');
  });

  it('срок истёк в потоке — RenderTimeoutError, поток пересоздан, следующий отчёт строится', async () => {
    pool = new RenderPool({ size: 1, workerUrl });
    await expect(pool.run(job('hang'), soon(200))).rejects.toThrow(RenderTimeoutError);
    expect((await pool.run(job('echo'), soon(5000))).toString()).toBe('tpl!');
  });

  it('упавший поток — RenderCrashError, пул продолжает работать', async () => {
    const crashes: unknown[] = [];
    pool = new RenderPool({ size: 1, workerUrl, onCrash: (e) => crashes.push(e) });
    await expect(pool.run(job('crash'), soon(5000))).rejects.toThrow(RenderCrashError);
    expect(crashes).toHaveLength(1);
    expect((await pool.run(job('echo'), soon(5000))).toString()).toBe('tpl!');
  });

  it('задач больше, чем потоков: лишние ждут в очереди', async () => {
    pool = new RenderPool({ size: 1, workerUrl });
    const a = pool.run(job('slow', 150), soon(5000));
    const b = pool.run(job('echo'), soon(5000));
    expect((await a).toString()).toBe('tpl!');
    expect((await b).toString()).toBe('tpl!');
  });

  it('срок истёк в очереди — RenderTimeoutError без запуска, занятый поток не трогается', async () => {
    pool = new RenderPool({ size: 1, workerUrl });
    const slow = pool.run(job('slow', 400), soon(5000));
    const t0 = Date.now();
    await expect(pool.run(job('echo'), soon(100))).rejects.toThrow(RenderTimeoutError);
    expect(Date.now() - t0).toBeLessThan(350);
    expect((await slow).toString()).toBe('tpl!');
  });

  it('срок уже истёк — отказ сразу', async () => {
    pool = new RenderPool({ size: 1, workerUrl });
    await expect(pool.run(job('echo'), Date.now() - 1)).rejects.toThrow(RenderTimeoutError);
  });

  it('destroy отклоняет ожидающие задачи', async () => {
    pool = new RenderPool({ size: 1, workerUrl });
    const running = pool.run(job('hang'), soon(5000));
    const queued = pool.run(job('echo'), soon(5000));
    const r = expect(running).rejects.toThrow(RenderCrashError);
    const q = expect(queued).rejects.toThrow(RenderCrashError);
    await pool.destroy();
    await r;
    await q;
    pool = undefined;
  });

  it('буфер шаблона из общего пула Node не отсоединяется', async () => {
    pool = new RenderPool({ size: 1, workerUrl });
    const neighbour = Buffer.from('сосед');
    const template = Buffer.from('tpl'); // маленькие Buffer.from делят общий ArrayBuffer
    await pool.run({ ...job('echo'), template }, soon(5000));
    expect(neighbour.toString()).toBe('сосед');
    expect(template.toString()).toBe('tpl');
  });

  it('поток, падающий при загрузке: ограниченные пересоздания, задача получает RenderTimeoutError', async () => {
    const crashes: { beforeReady?: boolean }[] = [];
    pool = new RenderPool({
      size: 1,
      workerUrl: new URL('./test-workers/broken.mjs', import.meta.url),
      onCrash: (_e, ctx) => crashes.push(ctx ?? {}),
    });
    // дедлайн позже первого пересоздания (1 с): задача не отдаётся неготовому потоку
    await expect(pool.run(job('echo'), soon(1500))).rejects.toThrow(RenderTimeoutError);
    expect(crashes.length).toBeGreaterThanOrEqual(1);
    expect(crashes.length).toBeLessThanOrEqual(3);
    expect(crashes.every((c) => c.beforeReady)).toBe(true);
  });

  it('поток, упавший без задачи, попадает в onCrash', async () => {
    const crashes: unknown[] = [];
    pool = new RenderPool({
      size: 1,
      workerUrl: new URL('./test-workers/broken.mjs', import.meta.url),
      onCrash: (e) => crashes.push(e),
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(crashes.length).toBeGreaterThanOrEqual(1);
  });

  it('падение готового потока не вводит задержку для следующей задачи', async () => {
    pool = new RenderPool({ size: 1, workerUrl });
    await pool.run(job('echo'), soon(5000)); // поток точно готов
    await expect(pool.run(job('crash'), soon(5000))).rejects.toThrow(RenderCrashError);
    const t0 = Date.now();
    expect((await pool.run(job('echo'), soon(5000))).toString()).toBe('tpl!');
    expect(Date.now() - t0).toBeLessThan(800);
    await expect(pool.run(job('crash'), soon(5000))).rejects.toThrow(RenderCrashError);
    const t1 = Date.now();
    await pool.run(job('echo'), soon(5000));
    expect(Date.now() - t1).toBeLessThan(800);
  });

  it('данные, не сериализуемые в JSON, отклоняются сразу и не занимают поток', async () => {
    pool = new RenderPool({ size: 1, workerUrl });
    await expect(pool.run({ ...job('echo'), data: { n: 1n } }, soon(5000))).rejects.toThrow(
      TemplateRenderError,
    );
    await expect(pool.run({ ...job('echo'), data: undefined }, soon(5000))).rejects.toThrow(
      TemplateRenderError,
    );
    expect((await pool.run(job('echo'), soon(5000))).toString()).toBe('tpl!');
  });

  it('шаблон вызывающего не отсоединяется (100 КБ)', async () => {
    pool = new RenderPool({ size: 1, workerUrl });
    const template = Buffer.alloc(100 * 1024, 1);
    await pool.run({ ...job('echo'), template }, soon(5000));
    expect(template.length).toBe(100 * 1024);
  });
});
