import { PDFDocument, PDFDict, PDFName } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../../lib/errors';
import { RenderTimeoutError, TemplateRenderError, type RenderJob } from '../../render/pool';
import { makePdf } from '../test-pdf';
import type { SignPrepareJob } from './prepare';
import { createPoolSignPreparer, inProcessSignPreparer } from './preparer';

const job: SignPrepareJob = {
  position: 'bottom-right',
  lines: ['a', 'b', 'c', 'd', 'e'],
  contentsBytes: 1000,
  signedAt: '2026-10-19T11:32:00.000Z',
};

describe('createPoolSignPreparer', () => {
  it('задача sign: данные — сам job', async () => {
    let seen: RenderJob | undefined;
    const prepare = createPoolSignPreparer({
      run: async (j) => {
        seen = j;
        return { out: Buffer.from('OK'), warnings: [] };
      },
    });
    const out = await prepare(Buffer.from('%PDF'), job, 1000);
    expect(out.toString()).toBe('OK');
    expect(seen).toMatchObject({ kind: 'sign', ext: 'pdf', data: job });
  });

  it('ошибки пула: срок — 504, ошибка потока — 502 PDF_ERROR', async () => {
    const timeout = createPoolSignPreparer({
      run: async () => Promise.reject(new RenderTimeoutError()),
    });
    await expect(timeout(Buffer.from(''), job, 10)).rejects.toMatchObject({
      code: 'TIMEOUT',
      status: 504,
    });
    const broken = createPoolSignPreparer({
      run: async () => Promise.reject(new TemplateRenderError('x')),
    });
    const err = await broken(Buffer.from(''), job, 10).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect(err).toMatchObject({
      code: 'PDF_ERROR',
      status: 502,
      message: 'ошибка подготовки PDF к подписи: x',
    });
  });
});

describe('inProcessSignPreparer', () => {
  it('возвращает PDF с полем подписи', async () => {
    const out = await inProcessSignPreparer(
      Buffer.from(await makePdf([{ label: 'R1' }])),
      job,
      1000,
    );
    const doc = await PDFDocument.load(out);
    const annots = doc.getPages()[0]!.node.Annots()!;
    const widget = doc.context.lookup(annots.get(0), PDFDict);
    expect(widget.get(PDFName.of('FT'))).toBe(PDFName.of('Sig'));
  });
});
