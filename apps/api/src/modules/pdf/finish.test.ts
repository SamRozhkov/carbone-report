import { PdfOptions } from '@carbone-reports/shared';
import { describe, expect, it, vi } from 'vitest';
import { buildPdfJob, finishPdf, needsPostprocess, type TemplatePdf } from './finish';

const NOW = new Date('2026-10-15T09:30:00.000Z');
const tp = (options: object, attachments: TemplatePdf['attachments'] = []): TemplatePdf => ({
  options: PdfOptions.parse(options),
  attachments,
  templateName: 'Счёт',
});
const att = (name: string, placement: 'start' | 'end') => ({
  name,
  placement,
  sortOrder: 0,
  filePath: `templates/t/attachments/${name}`,
  pages: 1,
  pdfa: false,
});

describe('needsPostprocess', () => {
  it('без настроек и только PDF/A — нет; любой блок или приложение — да', () => {
    expect(needsPostprocess(tp({}))).toBe(false);
    expect(needsPostprocess(tp({ pdfa: true }))).toBe(false);
    expect(needsPostprocess(tp({ watermark: { text: 'x' } }))).toBe(true);
    expect(needsPostprocess(tp({ pageNumbers: {} }))).toBe(true);
    expect(needsPostprocess(tp({ metadata: { author: 'a' } }))).toBe(true);
    expect(needsPostprocess(tp({}, [att('a.pdf', 'end')]))).toBe(true);
  });
});

describe('buildPdfJob', () => {
  const data = { number: 42, params: { status: 'ЧЕРНОВИК' }, emoji: '😀', nl: 'а\nб' };

  it('теги подставлены и очищены; пустой title — имя шаблона', () => {
    const job = buildPdfJob(
      tp({
        pdfa: true,
        watermark: { text: '{d.params.status} {d.emoji}' },
        pageNumbers: { skipFirst: true },
        metadata: { title: '', author: 'Отдел {d.nl}', subject: '{d.missing}', keywords: '' },
      }),
      data,
      NOW,
      [],
    );
    expect(job).toEqual({
      pdfa: true,
      watermark: { text: 'ЧЕРНОВИК ?', opacity: 20, color: 'gray', angle: 'diagonal' },
      pageNumbers: { format: 'Стр. {page} из {pages}', position: 'bottom-center', skipFirst: true },
      metadata: { title: 'Счёт', author: 'Отдел а б', subject: '', keywords: '' },
      attachments: [],
      now: '2026-10-15T09:30:00.000Z',
    });
  });

  it('пустой после подстановки водяной знак не ставится', () => {
    expect(
      buildPdfJob(tp({ watermark: { text: '{d.params.none}' } }), data, NOW, []).watermark,
    ).toBeNull();
  });

  it('приложения — в порядке шаблона, файлы по индексу', () => {
    const files = [new Uint8Array([1]), new Uint8Array([2])];
    const job = buildPdfJob(tp({}, [att('a', 'start'), att('b', 'end')]), data, NOW, files);
    expect(job.attachments).toEqual([
      { placement: 'start', data: files[0] },
      { placement: 'end', data: files[1] },
    ]);
  });
});

describe('finishPdf', () => {
  const storage = (files: Record<string, Buffer>) => ({
    read: vi.fn(async (k: string) => {
      if (!files[k]) throw Object.assign(new Error('нет'), { code: 'ENOENT' });
      return files[k]!;
    }),
  });

  it('без обработки — тот же буфер, обработчик не вызывается', async () => {
    const pdf = vi.fn();
    const input = Buffer.from('%PDF-1.7 report');
    const out = await finishPdf(
      { storage: storage({}) as never, pdf },
      input,
      tp({ pdfa: true }),
      {},
      1000,
    );
    expect(out).toBe(input);
    expect(pdf).not.toHaveBeenCalled();
  });

  it('файл приложения недоступен — 502 с именем', async () => {
    const err = await finishPdf(
      { storage: storage({}) as never, pdf: vi.fn() },
      Buffer.from('%PDF'),
      tp({}, [att('Условия.pdf', 'end')]),
      {},
      1000,
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: 'STORAGE_ERROR',
      status: 502,
      message: 'приложенный файл «Условия.pdf» недоступен',
    });
  });

  it('итог больше 100 МБ — 400', async () => {
    const pdf = vi.fn(async () => Buffer.alloc(100 * 1024 * 1024 + 1));
    const err = await finishPdf(
      { storage: storage({}) as never, pdf },
      Buffer.from('%PDF'),
      tp({ pageNumbers: {} }),
      {},
      1000,
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 400, message: 'итоговый PDF больше 100 МБ' });
  });
});
