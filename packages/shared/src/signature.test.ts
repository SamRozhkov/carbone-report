import { describe, expect, it } from 'vitest';
import { CertificateInfo, MyCertificate, RunSignature, SignRunBody } from './signature';

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
    };
    expect(RunSignature.parse(s)).toEqual(s);
  });
});
