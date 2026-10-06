import { randomBytes } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { GenericContainer, type StartedTestContainer } from 'testcontainers';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    pgUri: string;
    redisUrl: string;
  }
}

let container: StartedPostgreSqlContainer | undefined;
let redis: StartedTestContainer | undefined;

export default async function setup(project: TestProject) {
  // Как в compose: Redis с паролем (hex, без экранирования в URL).
  const redisPassword = randomBytes(32).toString('hex');
  [container, redis] = await Promise.all([
    new PostgreSqlContainer('postgres:17-alpine').start(),
    new GenericContainer('redis:7-alpine')
      .withCommand(['redis-server', '--requirepass', redisPassword, '--save', ''])
      .withExposedPorts(6379)
      .start(),
  ]);
  project.provide('pgUri', container.getConnectionUri());
  project.provide(
    'redisUrl',
    `redis://:${redisPassword}@${redis.getHost()}:${redis.getMappedPort(6379)}`,
  );
  return async () => {
    await Promise.all([container?.stop(), redis?.stop()]);
  };
}
