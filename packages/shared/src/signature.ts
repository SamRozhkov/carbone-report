import { z } from 'zod';

// Электронная подпись PDF (§39). Модуль не импортирует ./index.

export const CERT_EXPIRY_WARNING_DAYS = 30;

/** Сведения о сертификате пользователя; serial и fingerprint — hex в верхнем регистре, даты — ISO. */
export const CertificateInfo = z.object({
  subjectCn: z.string(),
  issuer: z.string(),
  serial: z.string(),
  notBefore: z.string(),
  notAfter: z.string(),
  fingerprint: z.string(),
  keyAlg: z.string(),
});
export type CertificateInfo = z.infer<typeof CertificateInfo>;

/** Ответ GET /api/me/certificate: null — сертификат не загружен. */
export const MyCertificate = z.object({ certificate: CertificateInfo.nullable() });
export type MyCertificate = z.infer<typeof MyCertificate>;

export const RunSignature = z.object({
  signerCn: z.string(),
  fingerprint: z.string(),
  signedAt: z.string(),
  timestamped: z.boolean(),
});
export type RunSignature = z.infer<typeof RunSignature>;

export const SignRunBody = z.strictObject({ password: z.string().min(1).max(256) });
export type SignRunBody = z.infer<typeof SignRunBody>;
