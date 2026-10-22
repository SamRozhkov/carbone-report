import { PdfOptions } from '@carbone-reports/shared';
import { describe, expect, it, vi } from 'vitest';
import { encryptSecret } from '../../lib/crypto';
import { buildPdfJob, finishPdf, needsPostprocess, templatePdf, type TemplatePdf } from './finish';

const NOW = new Date('2026-10-15T09:30:00.000Z');
const tp = (
  options: object,
  attachments: TemplatePdf['attachments'] = [],
  protection: TemplatePdf['protection'] = null,
): TemplatePdf => ({
  options: PdfOptions.parse(options),
  attachments,
  templateName: 'Счёт',
  protection,
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

  it('теги подставлены, управляющие символы → пробел; пустой title — имя шаблона', () => {
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
      // Символы вне шрифта заменяет постобработка по шрифту строки (§45.5).
      watermark: { text: 'ЧЕРНОВИК 😀', opacity: 20, color: 'gray', angle: 'diagonal' },
      pageNumbers: { format: 'Стр. {page} из {pages}', position: 'bottom-center', skipFirst: true },
      metadata: { title: 'Счёт', author: 'Отдел а б', subject: '', keywords: '' },
      attachments: [],
      now: '2026-10-15T09:30:00.000Z',
    });
  });

  it('иероглифы не заменяются на «?» до выбора шрифта', () => {
    const job = buildPdfJob(
      tp({ watermark: { text: '机密 {d.name}' }, metadata: { title: '报告 {d.name}' } }),
      { name: '李伟' },
      NOW,
      [],
    );
    expect(job.watermark?.text).toBe('机密 李伟');
    expect(job.metadata?.title).toBe('报告 李伟');
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
      { storage: storage({}) as never, pdf, pdfProtect: vi.fn() },
      input,
      tp({ pdfa: true }),
      {},
      () => 1000,
    );
    expect(out).toBe(input);
    expect(pdf).not.toHaveBeenCalled();
  });

  it('файл приложения недоступен — 502 с именем', async () => {
    const err = await finishPdf(
      { storage: storage({}) as never, pdf: vi.fn(), pdfProtect: vi.fn() },
      Buffer.from('%PDF'),
      tp({}, [att('Условия.pdf', 'end')]),
      {},
      () => 1000,
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
      { storage: storage({}) as never, pdf, pdfProtect: vi.fn() },
      Buffer.from('%PDF'),
      tp({ pageNumbers: {} }),
      {},
      () => 1000,
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 400, message: 'итоговый PDF больше 100 МБ' });
  });
});

describe('templatePdf — защита (§37.2)', () => {
  const KEY = Buffer.alloc(32, 7);
  const full = (options: object, enc: string | null) =>
    ({
      row: { name: 'Счёт', pdfPasswordEnc: enc },
      pdfOptions: PdfOptions.parse(options),
      attachments: [],
    }) as never;

  it('без пароля и запретов — null', () => {
    expect(templatePdf(full({}, null), KEY).protection).toBeNull();
  });

  it('только запреты — пустой пароль на открытие', () => {
    expect(templatePdf(full({ protection: { noPrint: true } }, null), KEY).protection).toEqual({
      userPassword: '',
      noPrint: true,
      noCopy: false,
      noModify: false,
    });
  });

  it('пароль расшифрован; key null (предпросмотр) — без защиты', () => {
    const enc = encryptSecret('секрет1', KEY);
    expect(templatePdf(full({}, enc), KEY).protection).toEqual({
      userPassword: 'секрет1',
      noPrint: false,
      noCopy: false,
      noModify: false,
    });
    expect(templatePdf(full({ protection: { noCopy: true } }, enc), null).protection).toBeNull();
  });
});

describe('finishPdf — шифрование', () => {
  const storage = { read: vi.fn() };
  const job = { userPassword: 'п', noPrint: true, noCopy: false, noModify: false };

  it('только защита: обработка pdf-lib не вызывается, шифруется вход', async () => {
    const pdf = vi.fn();
    const pdfProtect = vi.fn(async () => Buffer.from('ENC'));
    const input = Buffer.from('%PDF report');
    const out = await finishPdf(
      { storage: storage as never, pdf, pdfProtect },
      input,
      tp({}, [], job),
      {},
      () => 1000,
    );
    expect(out.toString()).toBe('ENC');
    expect(pdf).not.toHaveBeenCalled();
    expect(pdfProtect).toHaveBeenCalledWith(input, job, 1000);
  });

  it('срок для шифрования пересчитывается после обработки', async () => {
    const pdf = vi.fn(async (_b: Buffer, _j: unknown, _t: number) => Buffer.from('POST'));
    const pdfProtect = vi.fn(async (b: Buffer, _j: unknown, _t: number) => b);
    const left = vi.fn().mockReturnValueOnce(1000).mockReturnValueOnce(400);
    await finishPdf(
      { storage: storage as never, pdf, pdfProtect },
      Buffer.from('%PDF'),
      tp({ pageNumbers: {} }, [], job),
      {},
      left,
    );
    expect(pdf.mock.calls[0]![2]).toBe(1000);
    expect(pdfProtect.mock.calls[0]![2]).toBe(400);
  });

  it('обработка и защита: шифруется результат обработки', async () => {
    const pdf = vi.fn(async () => Buffer.from('POST'));
    const pdfProtect = vi.fn(async (b: Buffer) => Buffer.concat([b, Buffer.from('+ENC')]));
    const out = await finishPdf(
      { storage: storage as never, pdf, pdfProtect },
      Buffer.from('%PDF'),
      tp({ pageNumbers: {} }, [], job),
      {},
      () => 1000,
    );
    expect(out.toString()).toBe('POST+ENC');
  });

  it('без защиты шифрование не вызывается', async () => {
    const pdfProtect = vi.fn();
    await finishPdf(
      { storage: storage as never, pdf: vi.fn(async () => Buffer.from('POST')), pdfProtect },
      Buffer.from('%PDF'),
      tp({ pageNumbers: {} }),
      {},
      () => 1000,
    );
    expect(pdfProtect).not.toHaveBeenCalled();
  });

  it('зашифрованный итог больше 100 МБ — 400', async () => {
    const pdfProtect = vi.fn(async () => Buffer.alloc(100 * 1024 * 1024 + 1));
    const err = await finishPdf(
      { storage: storage as never, pdf: vi.fn(), pdfProtect },
      Buffer.from('%PDF'),
      tp({}, [], job),
      {},
      () => 1000,
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 400, message: 'итоговый PDF больше 100 МБ' });
  });
});
