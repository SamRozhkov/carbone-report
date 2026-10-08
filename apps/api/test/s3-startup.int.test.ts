import { HeadBucketCommand } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import type { S3Settings } from '../src/config';
import { createStorage } from '../src/lib/create-storage';
import { createS3Client, S3Storage } from '../src/lib/s3-storage';
import { LocalStorage, passThrough } from '../src/lib/storage';
import { dropTestBucket, testBucketName, testS3Settings } from './helpers';

const s3Config = (s3: S3Settings) => ({
  storageBackend: 's3' as const,
  storageDir: '/nonexistent',
  s3,
});

/** HTTP-статус HeadBucket: 200 — бакет есть, 404 — нет. */
async function bucketStatus(bucket: string): Promise<number | undefined> {
  const client = createS3Client(testS3Settings(bucket));
  try {
    await client.send(new HeadBucketCommand({ Bucket: bucket }));
    return 200;
  } catch (e) {
    return (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  } finally {
    client.destroy();
  }
}

describe('проверка бакета при старте (createStorage)', () => {
  it('local: LocalStorage, к S3 не обращается', async () => {
    const s = await createStorage(
      { storageBackend: 'local', storageDir: '/tmp/cr-local', s3: null },
      passThrough,
    );
    expect(s).toBeInstanceOf(LocalStorage);
  });

  it('бакета нет, S3_CREATE_BUCKET=false — ошибка «бакет S3_BUCKET не найден», бакет не создан', async () => {
    const bucket = testBucketName();
    await expect(createStorage(s3Config(testS3Settings(bucket)), passThrough)).rejects.toThrow(
      `бакет S3_BUCKET не найден: ${bucket}. Создайте его или задайте S3_CREATE_BUCKET=true`,
    );
    expect(await bucketStatus(bucket)).toBe(404);
  });

  it('бакета нет, S3_CREATE_BUCKET=true — бакет создаётся один раз, хранилище работает, секретов в журнале нет', async () => {
    const settings = testS3Settings(testBucketName(), { createBucket: true });
    const logged: string[] = [];
    const log = { info: (m: string) => void logged.push(m) };
    try {
      const storage = await createStorage(s3Config(settings), passThrough, log);
      expect(storage).toBeInstanceOf(S3Storage);
      expect(await bucketStatus(settings.bucket)).toBe(200);
      await storage.write('templates/t/v1.docx', Buffer.from('ok'));
      expect((await storage.read('templates/t/v1.docx')).toString()).toBe('ok');
      // Повторный старт или второй экземпляр API: бакет уже есть, создавать нечего.
      await createStorage(s3Config(settings), passThrough, log);
      expect(logged).toEqual([`бакет S3_BUCKET создан: ${settings.bucket}`]);
      expect(logged.join('\n')).not.toContain(settings.secretAccessKey);
      expect(logged.join('\n')).not.toContain(settings.accessKeyId);
    } finally {
      await dropTestBucket(settings);
    }
  });

  it('неверный секрет — понятная ошибка без ключей доступа, бакет не создан', async () => {
    const secret = 'wrong-secret-value-123';
    const settings = testS3Settings(testBucketName(), {
      secretAccessKey: secret,
      createBucket: true,
    });
    const err = await createStorage(s3Config(settings), passThrough).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toMatch(`проверка бакета S3_BUCKET не удалась: ${settings.bucket} (HTTP 403`);
    expect(message).not.toContain(secret);
    expect(message).not.toContain(settings.accessKeyId);
    expect((err as Error).cause).toBeUndefined();
    expect(await bucketStatus(settings.bucket)).toBe(404);
  });

  it('запись в отсутствующий бакет — NoSuchBucket, бакет не создаётся (автосоздание SeaweedFS выключено)', async () => {
    const settings = testS3Settings(testBucketName());
    const client = createS3Client(settings);
    try {
      const storage = new S3Storage(client, settings.bucket);
      await expect(storage.write('templates/t/v1.docx', Buffer.from('x'))).rejects.toMatchObject({
        name: 'NoSuchBucket',
      });
    } finally {
      client.destroy();
    }
    expect(await bucketStatus(settings.bucket)).toBe(404);
  });
});
