import { describe, expect, it } from 'vitest';
import {
  fillPdfText,
  hasPdfProtection,
  MoveAttachmentBody,
  normalizePdfOptions,
  PDF_PAGE_FORMAT_DEFAULT,
  PdfOptions,
  PdfPassword,
  pdfStaticText,
  pdfTextIssues,
  SavePdfOptionsBody,
} from './pdf-options';

describe('PdfOptions', () => {
  it('пустой объект — PDF/A выключен, блоков нет', () => {
    expect(PdfOptions.parse({})).toEqual({ pdfa: false });
  });

  it('умолчания блоков', () => {
    expect(
      PdfOptions.parse({ watermark: { text: 'КОПИЯ' }, pageNumbers: {}, metadata: {} }),
    ).toEqual({
      pdfa: false,
      watermark: { text: 'КОПИЯ', opacity: 20, color: 'gray', angle: 'diagonal' },
      pageNumbers: { format: PDF_PAGE_FORMAT_DEFAULT, position: 'bottom-center', skipFirst: false },
      metadata: { title: '', author: '', subject: '', keywords: '' },
    });
  });

  it('границы и ошибки', () => {
    expect(PdfOptions.safeParse({ watermark: { text: ' ' } }).success).toBe(false);
    expect(PdfOptions.safeParse({ watermark: { text: 'x'.repeat(201) } }).success).toBe(false);
    expect(PdfOptions.safeParse({ watermark: { text: 'x', opacity: 9 } }).success).toBe(false);
    expect(PdfOptions.safeParse({ watermark: { text: 'x', opacity: 51 } }).success).toBe(false);
    expect(PdfOptions.safeParse({ watermark: { text: 'x', opacity: 15.5 } }).success).toBe(false);
    expect(PdfOptions.safeParse({ watermark: { text: 'x', color: 'green' } }).success).toBe(false);
    expect(PdfOptions.safeParse({ pageNumbers: { format: 'Страница' } }).success).toBe(false);
    expect(PdfOptions.safeParse({ pageNumbers: { format: '{page}' } }).success).toBe(true);
    expect(PdfOptions.safeParse({ metadata: { title: 'x'.repeat(501) } }).success).toBe(false);
    expect(PdfOptions.safeParse({ extra: 1 }).success).toBe(false);
  });

  it('normalizePdfOptions убирает пустые метаданные (R1)', () => {
    const o = PdfOptions.parse({ pdfa: true, metadata: {} });
    expect(normalizePdfOptions(o)).toEqual({ pdfa: true });
    const m = PdfOptions.parse({ metadata: { author: 'Отдел' } });
    expect(normalizePdfOptions(m).metadata?.author).toBe('Отдел');
  });

  it('MoveAttachmentBody', () => {
    expect(MoveAttachmentBody.parse({ placement: 'start', sortOrder: 0 })).toEqual({
      placement: 'start',
      sortOrder: 0,
    });
    expect(MoveAttachmentBody.safeParse({ sortOrder: -1 }).success).toBe(false);
  });
});

describe('fillPdfText', () => {
  const data = {
    number: 42,
    status: 'ЧЕРНОВИК',
    ok: true,
    empty: null,
    obj: { a: 1 },
    list: [{ name: 'Первый' }, { name: 'Второй' }],
    company: { name: 'ООО «Ромашка»', inn: '7700000000' },
    when: new Date('2026-10-15T09:30:00.000Z'),
  };

  it('простые пути, индексы, числа и булевы', () => {
    expect(fillPdfText('Счёт № {d.number}', data)).toBe('Счёт № 42');
    expect(fillPdfText('{d.company.name}, ИНН {d.company.inn}', data)).toBe(
      'ООО «Ромашка», ИНН 7700000000',
    );
    expect(fillPdfText('{d.list[1].name}', data)).toBe('Второй');
    expect(fillPdfText('{d.ok}', data)).toBe('true');
    expect(fillPdfText('{d.when}', data)).toBe('2026-10-15T09:30:00.000Z');
  });

  it('null, объект, массив, неизвестный путь, __proto__ — пустая строка', () => {
    expect(fillPdfText('[{d.empty}]', data)).toBe('[]');
    expect(fillPdfText('[{d.obj}]', data)).toBe('[]');
    expect(fillPdfText('[{d.list}]', data)).toBe('[]');
    expect(fillPdfText('[{d.nope.deeper}]', data)).toBe('[]');
    expect(fillPdfText('[{d.list[5].name}]', data)).toBe('[]');
    expect(fillPdfText('[{d.__proto__}]', data)).toBe('[]');
    expect(fillPdfText('[{d.company.name.length}]', data)).toBe('[]');
    expect(fillPdfText('[{d.number}]', null)).toBe('[]');
  });

  it('форматтеры, циклы и чужие теги остаются как есть', () => {
    expect(fillPdfText('{d.status:upper}', data)).toBe('{d.status:upper}');
    expect(fillPdfText('{d.list[i].name}', data)).toBe('{d.list[i].name}');
    expect(fillPdfText('{c.now} {d}', data)).toBe('{c.now} {d}');
  });

  it('статус черновика: пустое значение — пустой текст', () => {
    expect(fillPdfText('{d.status}', { status: '' })).toBe('');
  });
});

describe('pdfTextIssues и pdfStaticText', () => {
  it('теги без форматтеров — без ошибки', () => {
    expect(pdfTextIssues('Счёт № {d.number} от {d.list[0].date}')).toBeNull();
    expect(pdfTextIssues('без тегов')).toBeNull();
  });
  it('форматтер или цикл — ошибка с тегом', () => {
    expect(pdfTextIssues('Сумма {d.sum:formatC}')).toBe(
      'в полях PDF теги без форматтеров: {d.sum:formatC}',
    );
    expect(pdfTextIssues('{d.rows[i].x}')).toBe('в полях PDF теги без форматтеров: {d.rows[i].x}');
  });
  it('статическая часть', () => {
    expect(pdfStaticText('Счёт № {d.number} 😀')).toBe('Счёт №  😀');
  });
});

describe('защита PDF (§37.1)', () => {
  it('protection: флажки по умолчанию false, лишние ключи — ошибка', () => {
    expect(PdfOptions.parse({ protection: { noCopy: true } }).protection).toEqual({
      noPrint: false,
      noCopy: true,
      noModify: false,
    });
    expect(PdfOptions.safeParse({ protection: { noSave: true } }).success).toBe(false);
  });

  it('normalizePdfOptions убирает protection без запретов (R1)', () => {
    expect(normalizePdfOptions(PdfOptions.parse({ protection: {} }))).toEqual({ pdfa: false });
    expect(
      normalizePdfOptions(PdfOptions.parse({ protection: { noPrint: true } })).protection,
    ).toEqual({ noPrint: true, noCopy: false, noModify: false });
  });

  it('hasPdfProtection: пароль или хоть один запрет', () => {
    expect(hasPdfProtection({}, false)).toBe(false);
    expect(hasPdfProtection({}, true)).toBe(true);
    expect(
      hasPdfProtection({ protection: { noPrint: false, noCopy: false, noModify: false } }, false),
    ).toBe(false);
    expect(
      hasPdfProtection({ protection: { noPrint: false, noCopy: false, noModify: true } }, false),
    ).toBe(true);
  });

  it('PdfPassword: 4–64 символа по символам, пробелы сохраняются', () => {
    expect(PdfPassword.safeParse('abc').error?.issues[0]?.message).toBe(
      'пароль — от 4 до 64 символов',
    );
    expect(PdfPassword.parse(' пар ')).toBe(' пар ');
    expect(PdfPassword.safeParse('😀😀😀😀').success).toBe(true);
    expect(PdfPassword.safeParse('я'.repeat(64)).success).toBe(true);
    expect(PdfPassword.safeParse('я'.repeat(65)).success).toBe(false);
  });

  it('PdfPassword: управляющие символы запрещены', () => {
    for (const bad of ['abcd\n', 'ab\tcd', 'abc\u0000d', 'abc\u007fd', 'abc\u0085d']) {
      expect(PdfPassword.safeParse(bad).error?.issues.map((i) => i.message)).toContain(
        'пароль содержит недопустимые символы',
      );
    }
  });

  it('PdfPassword: «-» в начале запрещён', () => {
    for (const bad of ['-abcd', '--abcd']) {
      expect(PdfPassword.safeParse(bad).error?.issues.map((i) => i.message)).toContain(
        'пароль не может начинаться с «-»',
      );
    }
    expect(PdfPassword.safeParse('a-bcd').success).toBe(true);
  });

  it('SavePdfOptionsBody: password — не передан, строка или null; лишние ключи — ошибка', () => {
    expect(SavePdfOptionsBody.parse({}).password).toBeUndefined();
    expect(SavePdfOptionsBody.parse({ password: null }).password).toBeNull();
    expect(SavePdfOptionsBody.parse({ password: 'секрет1' }).password).toBe('секрет1');
    expect(SavePdfOptionsBody.safeParse({ password: '' }).success).toBe(false);
    expect(SavePdfOptionsBody.safeParse({ passwd: 'x' }).success).toBe(false);
    expect(SavePdfOptionsBody.parse({ pdfa: true }).pdfa).toBe(true);
  });
});

describe('PdfOptions.signature (§39.2)', () => {
  it('по умолчанию — штамп справа', () => {
    expect(PdfOptions.parse({ signature: {} }).signature).toEqual({ position: 'bottom-right' });
  });
  it('три положения, прочие — ошибка', () => {
    for (const position of ['bottom-left', 'bottom-center', 'bottom-right'] as const)
      expect(PdfOptions.parse({ signature: { position } }).signature?.position).toBe(position);
    expect(PdfOptions.safeParse({ signature: { position: 'top-right' } }).success).toBe(false);
    expect(PdfOptions.safeParse({ signature: { position: 'bottom-right', x: 1 } }).success).toBe(
      false,
    );
  });
  it('нормализация сохраняет блок', () => {
    expect(normalizePdfOptions(PdfOptions.parse({ signature: {} })).signature).toEqual({
      position: 'bottom-right',
    });
  });
  it('нет блока — подписи нет', () => {
    expect(PdfOptions.parse({}).signature).toBeUndefined();
  });
});
