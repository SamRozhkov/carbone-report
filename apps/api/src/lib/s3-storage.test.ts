import { afterEach, describe, expect, it, vi } from 'vitest';
import { createS3Client, S3_MAX_ATTEMPTS, S3_TIMEOUTS } from './s3-storage';

const base = { region: 'us-east-1', bucket: 'b', forcePathStyle: true, createBucket: false };

afterEach(() => vi.unstubAllEnvs());

describe('createS3Client', () => {
  it('две попытки и таймаут запроса 30 с: общий срок вызова — до минуты', async () => {
    expect(S3_MAX_ATTEMPTS).toBe(2);
    expect(S3_TIMEOUTS).toEqual({ connectionTimeoutMs: 5_000, requestTimeoutMs: 30_000 });
    expect(await createS3Client(base).config.maxAttempts()).toBe(2);
  });

  it('с ключами — статические учётные данные', async () => {
    const c = createS3Client({ ...base, accessKeyId: 'k-id', secretAccessKey: 'k-secret' });
    expect(await c.config.credentials()).toMatchObject({
      accessKeyId: 'k-id',
      secretAccessKey: 'k-secret',
    });
  });

  it('без ключей — цепочка по умолчанию (здесь переменные AWS_* окружения, в k8s — IRSA)', async () => {
    vi.stubEnv('AWS_ACCESS_KEY_ID', 'env-id');
    vi.stubEnv('AWS_SECRET_ACCESS_KEY', 'env-secret');
    const c = createS3Client(base);
    expect(await c.config.credentials()).toMatchObject({
      accessKeyId: 'env-id',
      secretAccessKey: 'env-secret',
    });
  });
});
