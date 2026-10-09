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

  it('поток, падающий при загрузке: нет плотного цикла пересоздания, задача ждёт срока', async () => {
    const crashes: unknown[] = [];
    pool = new RenderPool({
      size: 1,
      workerUrl: new URL('./test-workers/broken.mjs', import.meta.url),
      onCrash: (e) => crashes.push(e),
    });
    await new Promise((r) => setTimeout(r, 300)); // поток уже упал, пересоздание отложено
    await expect(pool.run(job('echo'), soon(600))).rejects.toThrow(RenderTimeoutError);
    // старт + одно пересоздание после паузы в 1 с (без задержки были бы десятки)
    expect(crashes.length).toBeGreaterThanOrEqual(1);
    expect(crashes.length).toBeLessThanOrEqual(3);
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
});
