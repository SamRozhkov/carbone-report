import { createHash } from 'node:crypto';
import type { CertificateInfo, PdfSignaturePosition } from '@carbone-reports/shared';
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
  /** Срок отчёта, мс от эпохи. */
  deadline: number;
  prepare: PdfSignPreparer;
}

function left(deadline: number): number {
  const ms = deadline - Date.now();
  if (ms <= 0) throw new AppError('TIMEOUT', 504, 'превышено время ожидания');
  return ms;
}

/** Строки штампа (§39.5): даты и время — в часовом поясе timeZone. */
export function stampLines(info: CertificateInfo, now: Date, timeZone: string): StampLines {
  const date = new Intl.DateTimeFormat('ru-RU', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
  const time = new Intl.DateTimeFormat('ru-RU', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  return [
    'ДОКУМЕНТ ПОДПИСАН ЭЛЕКТРОННОЙ ПОДПИСЬЮ',
    `Сертификат: ${info.serial}`,
    `Владелец: ${info.subjectCn}`,
    `Действителен: с ${date.format(new Date(info.notBefore))} по ${date.format(new Date(info.notAfter))}`,
    `Подписан: ${date.format(now)} ${time.format(now)}`,
  ];
}

/** Подписанный PDF (§39.4): подготовка в пуле, хэш ByteRange, CMS, вставка — всё в пределах deadline. */
export async function signPdf(pdf: Buffer, signer: CmsSigner, o: SignPdfOptions): Promise<Buffer> {
  const job: SignPrepareJob = {
    position: o.position,
    lines: stampLines(signer.info, o.now, o.timeZone),
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
