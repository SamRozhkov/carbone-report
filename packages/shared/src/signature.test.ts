import { describe, expect, it } from 'vitest';
import {
  CertificateInfo,
  GostCompleteBody,
  GostPrepareBody,
  GostPrepareResult,
  MyCertificate,
  RunSignature,
  SignMethod,
  SignRunBody,
} from './signature';

describe('типы подписи (§39)', () => {
  it('SignRunBody: пароль 1–256 символов, лишние поля — ошибка', () => {
    expect(SignRunBody.safeParse({ password: '' }).success).toBe(false);
    expect(SignRunBody.safeParse({ password: 'x'.repeat(257) }).success).toBe(false);
    expect(SignRunBody.parse({ password: ' p ' })).toEqual({ password: ' p ' });
    expect(SignRunBody.safeParse({ password: 'p', x: 1 }).success).toBe(false);
  });
  it('CertificateInfo и MyCertificate', () => {
    const info = {
      subjectCn: 'Иванов Иван Иванович',
      issuer: 'Тестовый УЦ',
      serial: '1001',
      notBefore: '2026-01-01T00:00:00.000Z',
      notAfter: '2036-01-01T00:00:00.000Z',
      fingerprint: 'AB'.repeat(32),
      keyAlg: 'RSA-2048',
    };
    expect(CertificateInfo.parse(info)).toEqual(info);
    expect(MyCertificate.parse({ certificate: null })).toEqual({ certificate: null });
  });
  it('RunSignature', () => {
    const s = {
      signerCn: 'X',
      fingerprint: 'AA',
      signedAt: '2026-10-19T11:32:00.000Z',
      timestamped: false,
      method: 'gost',
    };
    expect(RunSignature.parse(s)).toEqual(s);
    // Способ обязателен (§42.2).
    const { method: _m, ...noMethod } = s;
    expect(RunSignature.safeParse(noMethod).success).toBe(false);
    expect(RunSignature.safeParse({ ...s, method: 'x' }).success).toBe(false);
  });
});

describe('подпись ГОСТ (§42)', () => {
  it('SignMethod: p12 и gost', () => {
    expect(SignMethod.options).toEqual(['p12', 'gost']);
  });
  it('GostPrepareBody: base64 до 16 КБ DER, лишние поля — ошибка', () => {
    expect(GostPrepareBody.parse({ certificate: 'MIIB' })).toEqual({ certificate: 'MIIB' });
    expect(GostPrepareBody.safeParse({ certificate: 'не base64!' }).success).toBe(false);
    // 16 КБ = 16384 байта → 21848 символов base64.
    const max = Buffer.alloc(16384).toString('base64');
    expect(max.length).toBe(21848);
    expect(GostPrepareBody.safeParse({ certificate: max }).success).toBe(true);
    const over = Buffer.alloc(16387).toString('base64');
    expect(GostPrepareBody.safeParse({ certificate: over }).success).toBe(false);
    expect(GostPrepareBody.safeParse({ certificate: 'MIIB', x: 1 }).success).toBe(false);
  });
  it('GostCompleteBody: base64 до 64 КБ', () => {
    const max = Buffer.alloc(65536).toString('base64');
    expect(max.length).toBe(87384);
    expect(GostCompleteBody.safeParse({ signature: max }).success).toBe(true);
    const over = Buffer.alloc(65539).toString('base64');
    expect(GostCompleteBody.safeParse({ signature: over }).success).toBe(false);
    expect(GostCompleteBody.safeParse({ signature: '***' }).success).toBe(false);
  });
  it('GostPrepareResult', () => {
    const r = { hash: 'ab'.repeat(32), hashAlg: 'streebog256', tsaUrl: null };
    expect(GostPrepareResult.parse(r)).toEqual(r);
    expect(GostPrepareResult.safeParse({ ...r, hashAlg: 'sha256' }).success).toBe(false);
  });
});
