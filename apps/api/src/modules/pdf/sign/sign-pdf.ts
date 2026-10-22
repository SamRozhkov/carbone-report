import { createHash } from 'node:crypto';
import type { CertificateInfo, PdfSignaturePosition } from '@carbone-reports/shared';
import { localeTag, type Locale } from '@carbone-reports/shared/i18n';
import { createTranslator } from '@carbone-reports/shared/i18n/server';
import type { PdfSignPreparer } from '../../../deps';
import { AppError } from '../../../lib/errors';
import { nodeHash } from './cms';
import { fillByteRange, insertCms, signedRanges } from './embed';
import type { SignPrepareJob, StampLines } from './prepare';
import type { CmsSigner } from './signer';

export interface SignPdfOptions {
  position: PdfSignaturePosition;
  now: Date;
  /** Часовой пояс штампа (config.tz). */
  timeZone: string;
  /** Язык штампа — язык запуска (§45.2, runLocale). */
  locale: Locale;
  /** Срок отчёта, мс от эпохи. */
  deadline: number;
  prepare: PdfSignPreparer;
}

function left(deadline: number): number {
  const ms = deadline - Date.now();
  if (ms <= 0) throw new AppError('TIMEOUT', 504, { key: 'timeout' });
  return ms;
}

/**
 * Строки штампа (§39.5) на языке отчёта (§45.4): тексты — каталог `report`, даты и время — Intl
 * языка в часовом поясе timeZone (24 ч). Для ru — дословно как до 2.14.0.
 */
export function stampLines(
  info: CertificateInfo,
  now: Date,
  timeZone: string,
  locale: Locale,
): StampLines {
  const tag = localeTag(locale);
  const date = new Intl.DateTimeFormat(tag, {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
  const time = new Intl.DateTimeFormat(tag, {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const t = createTranslator(locale);
  return [
    t('report:stamp.title'),
    t('report:stamp.certificate', { serial: info.serial }),
    t('report:stamp.owner', { owner: info.subjectCn }),
    t('report:stamp.valid', {
      from: date.format(new Date(info.notBefore)),
      to: date.format(new Date(info.notAfter)),
    }),
    t('report:stamp.signed', { date: date.format(now), time: time.format(now) }),
  ];
}

/** Подписанный PDF (§39.4): подготовка в пуле, хэш ByteRange, CMS, вставка — всё в пределах deadline. */
export async function signPdf(pdf: Buffer, signer: CmsSigner, o: SignPdfOptions): Promise<Buffer> {
  const job: SignPrepareJob = {
    position: o.position,
    lines: stampLines(signer.info, o.now, o.timeZone, o.locale),
    contentsBytes: signer.reserveBytes,
    signedAt: o.now.toISOString(),
  };
  const prepared = await o.prepare(pdf, job, left(o.deadline));
  const hole = fillByteRange(prepared, signer.reserveBytes);
  const hash = createHash(nodeHash(signer.digestAlg));
  for (const part of signedRanges(prepared, hole)) hash.update(part);
  const cms = await signer.createCms(hash.digest(), o.deadline);
  left(o.deadline);
  insertCms(prepared, hole, cms);
  return prepared;
}
