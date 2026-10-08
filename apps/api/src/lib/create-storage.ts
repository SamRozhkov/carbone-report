import type { Config } from '../config';
import { createS3Client, ensureBucket, S3Storage } from './s3-storage';
import { LocalStorage, type RemoveGate, type Storage } from './storage';

/**
 * Хранилище по STORAGE_BACKEND. Для s3 до первого запроса проверяет бакет (при S3_CREATE_BUCKET
 * создаёт); ошибка останавливает старт API.
 */
export async function createStorage(
  config: Pick<Config, 'storageBackend' | 'storageDir' | 's3'>,
  gate: RemoveGate,
  log?: { info(msg: string): void },
): Promise<Storage> {
  if (config.storageBackend === 'local') return new LocalStorage(config.storageDir, gate);
  if (!config.s3) throw new Error('STORAGE_BACKEND=s3, но настройки S3 не заданы');
  const client = createS3Client(config.s3);
  await ensureBucket(client, config.s3, log);
  return new S3Storage(client, config.s3.bucket, gate);
}
