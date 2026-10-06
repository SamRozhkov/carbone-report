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
  [container, redis] = await Promise.all([
    new PostgreSqlContainer('postgres:17-alpine').start(),
    new GenericContainer('redis:7-alpine').withExposedPorts(6379).start(),
  ]);
  project.provide('pgUri', container.getConnectionUri());
  project.provide('redisUrl', `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`);
  return async () => {
    await Promise.all([container?.stop(), redis?.stop()]);
  };
}
