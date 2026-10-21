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

/** Способ подписи (§42.1): `.p12` на сервере (§39) или ГОСТ через КриптоПро ЭЦП Browser plug-in (§42). */
export const SignMethod = z.enum(['p12', 'gost']);
export type SignMethod = z.infer<typeof SignMethod>;

export const RunSignature = z.object({
  signerCn: z.string(),
  fingerprint: z.string(),
  signedAt: z.string(),
  timestamped: z.boolean(),
  method: SignMethod,
});
export type RunSignature = z.infer<typeof RunSignature>;

export const SignRunBody = z.strictObject({ password: z.string().min(1).max(256) });
export type SignRunBody = z.infer<typeof SignRunBody>;

// ---- Подпись по ГОСТ (§42.2) ----

/** POST /api/runs/:id/sign/gost/prepare: DER сертификата в base64, до 16 КБ (21848 символов). */
export const GostPrepareBody = z.strictObject({ certificate: z.base64().max(21848) });
export type GostPrepareBody = z.infer<typeof GostPrepareBody>;

/** Ответ подготовки: hash — hex для `HashedData.SetHashValue`; tsaUrl — SIGN_GOST_TSA_URL или null. */
export const GostPrepareResult = z.object({
  hash: z.string(),
  hashAlg: z.enum(['streebog256', 'streebog512']),
  tsaUrl: z.string().nullable(),
});
export type GostPrepareResult = z.infer<typeof GostPrepareResult>;

/** POST /api/runs/:id/sign/gost/complete: открепленная CAdES в base64, до 64 КБ (87384 символа). */
export const GostCompleteBody = z.strictObject({ signature: z.base64().max(87384) });
export type GostCompleteBody = z.infer<typeof GostCompleteBody>;
