import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import type { TestProject } from 'vitest/node';
import { S3_ENTRYPOINT_SOURCE, S3_ENTRYPOINT_TARGET, S3_IMAGE } from './images';

/** Тот же скрипт запуска SeaweedFS, что монтирует сервис s3 в docker-compose.yml. */
const S3_ENTRYPOINT = fileURLToPath(new URL(`../../../${S3_ENTRYPOINT_SOURCE}`, import.meta.url));

declare module 'vitest' {
  export interface ProvidedContext {
    pgUri: string;
    redisUrl: string;
    s3: { endpoint: string; accessKeyId: string; secretAccessKey: string };
  }
}

let container: StartedPostgreSqlContainer | undefined;
let redis: StartedTestContainer | undefined;
let s3: StartedTestContainer | undefined;

export default async function setup(project: TestProject) {
  // Как в compose: Redis с паролем (hex, без экранирования в URL).
  const redisPassword = randomBytes(32).toString('hex');
  // Как в compose: одна учётная запись S3 из S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY (hex).
  const s3Key = randomBytes(8).toString('hex');
  const s3Secret = randomBytes(16).toString('hex');
  [container, redis, s3] = await Promise.all([
    new PostgreSqlContainer('postgres:17-alpine').start(),
    new GenericContainer('redis:7-alpine')
      .withCommand(['redis-server', '--requirepass', redisPassword, '--save', ''])
      .withExposedPorts(6379)
      .start(),
    new GenericContainer(S3_IMAGE)
      .withEnvironment({ S3_ACCESS_KEY_ID: s3Key, S3_SECRET_ACCESS_KEY: s3Secret })
      .withCopyFilesToContainer([
        { source: S3_ENTRYPOINT, target: S3_ENTRYPOINT_TARGET, mode: 0o755 },
      ])
      .withEntrypoint([S3_ENTRYPOINT_TARGET])
      .withExposedPorts(8333)
      .withWaitStrategy(Wait.forHttp('/healthz', 8333))
      .start(),
  ]);
  project.provide('pgUri', container.getConnectionUri());
  project.provide(
    'redisUrl',
    `redis://:${redisPassword}@${redis.getHost()}:${redis.getMappedPort(6379)}`,
  );
  project.provide('s3', {
    endpoint: `http://${s3.getHost()}:${s3.getMappedPort(8333)}`,
    accessKeyId: s3Key,
    secretAccessKey: s3Secret,
  });
  return async () => {
    await Promise.all([container?.stop(), redis?.stop(), s3?.stop()]);
  };
}
