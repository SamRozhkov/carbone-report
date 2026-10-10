import { describe, expect, it, vi } from 'vitest';
import type { TemplateFileRef } from '../../deps';
import { createRenderHandoff } from './handoff';
import { RenderCrashError, RenderTimeoutError, TemplateRenderError } from './pool';
import { createEmbeddedRenderer } from './renderer';

const secret = new TextEncoder().encode('k'.repeat(32));
const tpl = (
  ext: TemplateFileRef['ext'] = 'docx',
  read = async () => Buffer.from('TPL'),
): TemplateFileRef => ({
  id: 't1',
  version: 1,
  ext,
  read,
});
const opts = (convertTo: string, timeoutMs = 5000) =>
  ({ convertTo, lang: 'ru', timezone: 'Europe/Moscow', timeoutMs }) as never;

function setup(
  run: (job: { template: Buffer }) => Promise<Buffer>,
  log?: { info(o: object, m: string): void },
) {
  const handoff = createRenderHandoff(secret);
  const convert = vi.fn(async (r: { url: string }) => {
    const u = new URL(r.url);
    const got = await handoff.take(u.pathname.split('/').pop()!, u.searchParams.get('t')!);
    if (typeof got === 'string') throw new Error(got);
    return Buffer.concat([Buffer.from('PDF:'), got.file]);
  });
  const renderer = createEmbeddedRenderer({
    pool: { run },
    handoff,
    convert,
    selfUrl: 'http://10.0.0.5:3000',
    log,
  });
  return { renderer, convert, handoff };
}

describe('createEmbeddedRenderer', () => {
  it('формат шаблона — без OnlyOffice', async () => {
    const { renderer, convert } = setup(async () => Buffer.from('OUT'));
    expect((await renderer.render(tpl(), {}, opts('docx'))).toString()).toBe('OUT');
    expect(convert).not.toHaveBeenCalled();
  });

  it('другой формат — файл отдаётся OnlyOffice по разовой ссылке на свою реплику', async () => {
    const { renderer, convert } = setup(async () => Buffer.from('OUT'));
    expect((await renderer.render(tpl(), {}, opts('pdf'))).toString()).toBe('PDF:OUT');
    const r = convert.mock.calls[0]![0] as { url: string; filetype: string; outputtype: string };
    expect(r.url).toMatch(/^http:\/\/10\.0\.0\.5:3000\/internal\/render-files\/[0-9a-f]{32}\?t=/);
    expect(r).toMatchObject({ filetype: 'docx', outputtype: 'pdf' });
  });

  it('после конвертации файла в памяти не остаётся, даже при ошибке', async () => {
    const { renderer, handoff, convert } = setup(async () => Buffer.from('OUT'));
    const put = vi.spyOn(handoff, 'put');
    convert.mockRejectedValueOnce(new Error('oo'));
    await expect(renderer.render(tpl(), {}, opts('pdf'))).rejects.toThrow();
    const { id, token } = await put.mock.results[0]!.value;
    expect(await handoff.take(id, token)).toBe('gone');
  });

  it('ошибка чтения шаблона пробрасывается как есть', async () => {
    const err = Object.assign(new Error('нет файла'), { code: 'ENOENT' });
    const { renderer } = setup(async () => Buffer.from('OUT'));
    await expect(
      renderer.render(
        tpl('docx', async () => {
          throw err;
        }),
        {},
        opts('pdf'),
      ),
    ).rejects.toBe(err);
  });

  it('отключённая функция — 400 CARBONE_COMMUNITY с именем', async () => {
    const { renderer } = setup(async () => {
      throw new TemplateRenderError('Formatter "html" is disabled in the Community Edition.');
    });
    await expect(renderer.render(tpl(), {}, opts('pdf'))).rejects.toMatchObject({
      code: 'CARBONE_COMMUNITY',
      status: 400,
      message: expect.stringContaining('html'),
    });
  });

  it('другая ошибка шаблона — 502 CARBONE_ERROR с текстом Carbone', async () => {
    const { renderer } = setup(async () => {
      throw new TemplateRenderError('Formatter "fooBar" does not exist. Do you mean "mod"?');
    });
    await expect(renderer.render(tpl(), {}, opts('docx'))).rejects.toMatchObject({
      code: 'CARBONE_ERROR',
      status: 502,
      message: 'ошибка генерации: Formatter "fooBar" does not exist. Do you mean "mod"?',
    });
  });

  it('срок — 504 TIMEOUT; упавший поток — 502 «сервис генерации недоступен»', async () => {
    const t = setup(async () => {
      throw new RenderTimeoutError();
    });
    await expect(t.renderer.render(tpl(), {}, opts('docx'))).rejects.toMatchObject({
      code: 'TIMEOUT',
      status: 504,
    });
    const c = setup(async () => {
      throw new RenderCrashError('x');
    });
    await expect(c.renderer.render(tpl(), {}, opts('docx'))).rejects.toMatchObject({
      code: 'CARBONE_ERROR',
      status: 502,
      message: 'сервис генерации недоступен',
    });
  });

  it('недопустимая пара форматов — отказ без рендера', async () => {
    const run = vi.fn(async () => Buffer.from('OUT'));
    const { renderer } = setup(run);
    await expect(renderer.render(tpl('pptx'), {}, opts('xlsx'))).rejects.toMatchObject({
      status: 400,
    });
    expect(run).not.toHaveBeenCalled();
  });

  it('ошибка шаблона пишется в журнал (info) с текстом Carbone, без данных', async () => {
    const info = vi.fn();
    const { renderer } = setup(
      async () => {
        throw new TemplateRenderError('Formatter "x" does not exist');
      },
      { info },
    );
    await expect(renderer.render(tpl(), { secret: 'данные' }, opts('docx'))).rejects.toMatchObject({
      code: 'CARBONE_ERROR',
    });
    expect(info).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledWith(
      { templateId: 't1', version: 1, carboneError: 'Formatter "x" does not exist' },
      'ошибка шаблона Carbone',
    );
  });
});

describe('createEmbeddedRenderer: учёт активных отчётов', () => {
  it('active() = 1 во время рендера, 0 после успеха; idle() ждёт завершения', async () => {
    let finish!: (b: Buffer) => void;
    const { renderer } = setup(() => new Promise<Buffer>((r) => (finish = r)));
    expect(renderer.active()).toBe(0);
    await renderer.idle(); // при 0 — сразу
    const p = renderer.render(tpl(), {}, opts('docx'));
    await vi.waitFor(() => expect(renderer.active()).toBe(1));
    let idle = false;
    void renderer.idle().then(() => (idle = true));
    await new Promise((r) => setTimeout(r, 10));
    expect(idle).toBe(false);
    finish(Buffer.from('OUT'));
    await p;
    expect(renderer.active()).toBe(0);
    await vi.waitFor(() => expect(idle).toBe(true));
  });

  it('после ошибки active() снова 0', async () => {
    const { renderer } = setup(async () => {
      throw new RenderCrashError('x');
    });
    await expect(renderer.render(tpl(), {}, opts('docx'))).rejects.toThrow();
    expect(renderer.active()).toBe(0);
    await renderer.idle();
  });
});
