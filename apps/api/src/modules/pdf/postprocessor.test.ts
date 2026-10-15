import { describe, expect, it } from 'vitest';
import { AppError } from '../../lib/errors';
import { RenderTimeoutError, TemplateRenderError, type RenderJob } from '../render/pool';
import { createPoolPdfPostprocessor, inProcessPdfPostprocessor } from './postprocessor';
import type { PdfPostJob } from './postprocess';
import { makePdf, pageTexts } from './test-pdf';

const job = (attachments: PdfPostJob['attachments'] = []): PdfPostJob => ({
  pdfa: false,
  watermark: null,
  pageNumbers: { format: '{page}/{pages}', position: 'bottom-center', skipFirst: false },
  metadata: null,
  attachments,
  now: '2026-10-15T09:30:00.000Z',
});

describe('createPoolPdfPostprocessor', () => {
  it('задача pdf: файлы приложений — в extra, в данных только placement', async () => {
    let seen: RenderJob | undefined;
    const post = createPoolPdfPostprocessor({
      run: async (j) => {
        seen = j;
        return { out: Buffer.from('OK'), warnings: [] };
      },
    });
    const a = new Uint8Array([1, 2, 3]);
    const out = await post(Buffer.from('%PDF'), job([{ placement: 'start', data: a }]), 1000);
    expect(out.toString()).toBe('OK');
    expect(seen).toMatchObject({ kind: 'pdf', ext: 'pdf', extra: [a] });
    expect((seen!.data as PdfPostJob).attachments).toEqual([{ placement: 'start' }]);
  });

  it('ошибки пула: срок — 504, ошибка потока — 502 PDF_ERROR', async () => {
    const timeout = createPoolPdfPostprocessor({
      run: async () => Promise.reject(new RenderTimeoutError()),
    });
    await expect(timeout(Buffer.from(''), job(), 10)).rejects.toMatchObject({
      code: 'TIMEOUT',
      status: 504,
    });
    const broken = createPoolPdfPostprocessor({
      run: async () => Promise.reject(new TemplateRenderError('Failed to parse PDF')),
    });
    const err = await broken(Buffer.from(''), job(), 10).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({
      code: 'PDF_ERROR',
      status: 502,
      message: 'ошибка обработки PDF: Failed to parse PDF',
    });
  });
});

describe('inProcessPdfPostprocessor', () => {
  it('обрабатывает в этом потоке', async () => {
    const out = await inProcessPdfPostprocessor(
      Buffer.from(await makePdf([{ label: 'R1' }])),
      job(),
      1000,
    );
    expect((await pageTexts(out))[0]).toContain('1/1');
  });
});
