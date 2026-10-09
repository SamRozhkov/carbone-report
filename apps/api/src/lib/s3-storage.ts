import {
  type BucketLocationConstraint,
  CreateBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import type { S3Settings } from '../config';
import { checkKey, passThrough, type RemoveGate, type Storage } from './storage';

/** ListObjectsV2 отдаёт не больше 1000 ключей за страницу, DeleteObjects принимает не больше 1000. */
const PAGE = 1000;

const httpStatus = (e: unknown) =>
  (e as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;
const errorName = (e: unknown) => (e as { name?: string } | null)?.name;

/** Нет объекта — как на диске: вызывающие проверяют code === 'ENOENT' (410, запасное чтение шаблона). */
function enoent(key: string, cause: unknown): NodeJS.ErrnoException {
  return Object.assign(new Error(`ENOENT: нет объекта ${key}`, { cause }), { code: 'ENOENT' });
}

/** Таймауты HTTP-запроса к S3, мс. */
export interface S3Timeouts {
  /** Установка TCP-соединения. */
  connectionTimeoutMs: number;
  /** Тишина в сокете после отправки запроса. */
  requestTimeoutMs: number;
}

export const S3_TIMEOUTS: S3Timeouts = { connectionTimeoutMs: 5_000, requestTimeoutMs: 30_000 };

/** Попыток на вызов: с таймаутом 30 с общий срок — до минуты (по умолчанию у SDK 3 попытки). */
export const S3_MAX_ATTEMPTS = 2;

/**
 * Клиент S3 с таймаутами: по умолчанию у SDK их нет, и зависший S3 держал бы шлюз удаления,
 * блокировки в БД и старт API. Без throwOnRequestTimeout requestTimeout лишь пишет предупреждение.
 * Таймаут — повторяемая ошибка: S3_MAX_ATTEMPTS попыток, общий срок — до 2 × requestTimeout.
 * Без ключей — цепочка учётных данных SDK по умолчанию (IRSA в k8s, переменные AWS_*).
 */
export function createS3Client(s: S3Settings, t: S3Timeouts = S3_TIMEOUTS): S3Client {
  return new S3Client({
    requestHandler: new NodeHttpHandler({
      connectionTimeout: t.connectionTimeoutMs,
      requestTimeout: t.requestTimeoutMs,
      throwOnRequestTimeout: true,
    }),
    maxAttempts: S3_MAX_ATTEMPTS,
    region: s.region,
    endpoint: s.endpoint,
    forcePathStyle: s.forcePathStyle,
    ...(s.accessKeyId && s.secretAccessKey
      ? { credentials: { accessKeyId: s.accessKeyId, secretAccessKey: s.secretAccessKey } }
      : {}),
    // S3-совместимые хранилища (SeaweedFS и др.): контрольные суммы — только там, где их требует API.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

/**
 * Файлы в бакете S3. Ключ проверяется до запроса. Ошибки S3 и сети поднимаются как есть;
 * повторы делает SDK (стандартная политика). Только NoSuchKey превращается в ENOENT.
 */
export class S3Storage implements Storage {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
    private readonly removeGate: RemoveGate = passThrough,
  ) {}

  /** Один PutObject: объект появляется целиком или не появляется, временных объектов нет. */
  async write(key: string, data: Buffer): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: checkKey(key), Body: data }),
    );
  }

  async read(key: string): Promise<Buffer> {
    checkKey(key);
    try {
      const r = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      const bytes = await r.Body!.transformToByteArray();
      return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    } catch (e) {
      // Только «нет такого ключа»: нет бакета, нет доступа, сбой сети — не «файл удалён».
      if (errorName(e) === 'NoSuchKey') throw enoent(key, e);
      throw e;
    }
  }

  /** Закрывает соединения клиента S3 (keep-alive), чтобы остановка процесса не ждала их. */
  async close(): Promise<void> {
    this.client.destroy();
  }

  /**
   * 404 у HeadObject — и «нет объекта», и «нет бакета»: оба дают false. Это безопасно: бакет
   * проверяет ensureBucket при старте API, а единственный вызывающий — migrateTemplateFiles
   * (после старта), где false — лишь пропуск переноса с предупреждением в журнале.
   */
  async exists(key: string): Promise<boolean> {
    checkKey(key);
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (e) {
      if (httpStatus(e) === 404) return false;
      throw e;
    }
  }

  async remove(key: string): Promise<void> {
    checkKey(key);
    await this.removeGate(() => this.removeAll(key));
  }

  async removeUngated(key: string): Promise<void> {
    await this.removeAll(checkKey(key));
  }

  /** Объект key и все объекты под key/ (как rm -rf). Префикс с «/»: reports/r1 не задевает reports/r10. */
  private async removeAll(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: `${key}/`,
          MaxKeys: PAGE,
          ContinuationToken: token,
        }),
      );
      const objects = (page.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
      if (objects.length) {
        const r = await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: objects, Quiet: true },
          }),
        );
        if (r.Errors?.length) {
          const first = r.Errors[0]!;
          throw new Error(
            `S3: не удалось удалить объектов: ${r.Errors.length}, например ${first.Key} (${first.Code})`,
          );
        }
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }
}

/**
 * Проверка бакета при старте API (HeadBucket). Нет бакета: createBucket — создать, иначе ошибка.
 * В сообщениях только имя бакета, HTTP-статус и имя ошибки S3; cause не прикладывается,
 * чтобы в журнал не попали подробности запроса. Секретный ключ в S3 не передаётся вовсе.
 */
export async function ensureBucket(
  client: S3Client,
  s: S3Settings,
  log?: { info(msg: string): void },
): Promise<void> {
  try {
    await client.send(new HeadBucketCommand({ Bucket: s.bucket }));
    return;
  } catch (e) {
    const status = httpStatus(e);
    if (status !== 404) {
      const why = status ? `HTTP ${status} ${errorName(e) ?? ''}`.trim() : (e as Error).message;
      // eslint-disable-next-line preserve-caught-error -- без cause: подробности запроса не попадают в журнал
      throw new Error(`проверка бакета S3_BUCKET не удалась: ${s.bucket} (${why})`);
    }
  }
  if (!s.createBucket)
    throw new Error(
      `бакет S3_BUCKET не найден: ${s.bucket}. Создайте его или задайте S3_CREATE_BUCKET=true`,
    );
  try {
    await client.send(
      new CreateBucketCommand({
        Bucket: s.bucket,
        ...(s.region === 'us-east-1'
          ? {}
          : {
              CreateBucketConfiguration: {
                LocationConstraint: s.region as BucketLocationConstraint,
              },
            }),
      }),
    );
  } catch (e) {
    // Другой экземпляр API создал бакет одновременно с нами.
    if (errorName(e) === 'BucketAlreadyOwnedByYou') return;
    // eslint-disable-next-line preserve-caught-error -- без cause: подробности запроса не попадают в журнал
    throw new Error(
      `не удалось создать бакет S3_BUCKET: ${s.bucket} (HTTP ${httpStatus(e) ?? '—'} ${errorName(e) ?? ''})`.trim(),
    );
  }
  log?.info(`бакет S3_BUCKET создан: ${s.bucket}`);
}
