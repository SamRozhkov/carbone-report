// Только для тестов: тестовые сертификаты подписи (apps/api/test/fixtures/sign, make.sh).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const FIXTURE_PASSWORD = 'test-password';

const DIR = fileURLToPath(new URL('../../../../test/fixtures/sign/', import.meta.url));

export const fixturePath = (name: string) => DIR + name;
export const fixture = (name: string): Buffer => readFileSync(fixturePath(name));

/** DER сертификата из PEM. */
export const fixtureCertDer = (name: string): Buffer =>
  Buffer.from(readFileSync(fixturePath(name), 'utf8').replace(/-----[^-]+-----|\s/g, ''), 'base64');
