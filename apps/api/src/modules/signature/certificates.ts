import type { CertificateInfo } from '@carbone-reports/shared';
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { userCertificates, type UserCertificateRow } from '../../db/schema';
import { AppError, text } from '../../lib/errors';
import type { P12Error } from '../pdf/sign/p12';

export async function loadUserCertificate(
  db: Db,
  userId: string,
): Promise<UserCertificateRow | undefined> {
  const [row] = await db.select().from(userCertificates).where(eq(userCertificates.userId, userId));
  return row;
}

export const toCertificateInfo = (r: UserCertificateRow): CertificateInfo => ({
  subjectCn: r.subjectCn,
  issuer: r.issuer,
  serial: r.serial,
  notBefore: r.notBefore.toISOString(),
  notAfter: r.notAfter.toISOString(),
  fingerprint: r.fingerprint,
  keyAlg: r.keyAlg,
});

/** Ошибка у поля формы: /file или /password (§39.1). */
export const p12FieldError = (e: P12Error) =>
  new AppError('VALIDATION', 400, { key: 'validation' }, [
    { path: `/${e.field}`, message: text(e.key) },
  ]);
