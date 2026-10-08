import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import {
  GenericContainer,
  Network,
  Wait,
  type StartedNetwork,
  type StartedTestContainer,
} from 'testcontainers';
import type { TestProject } from 'vitest/node';

/** Образ агента для тестов — из того же Dockerfile, что в compose и CI. */
const AGENT_IMAGE = 'carbone-reports-backup:it';
/** Тот же образ SeaweedFS и скрипт запуска, что у сервиса s3 (apps/api/test/images.ts). */
const S3_IMAGE = 'chrislusf/seaweedfs:4.48';
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const S3_ENTRYPOINT = fileURLToPath(new URL('../../../docker/s3/entrypoint.sh', import.meta.url));

declare module 'vitest' {
  export interface ProvidedContext {
    agentImage: string;
    network: string;
    pg: { host: string; port: number; user: string; password: string };
    redis: { password: string; url: string };
    s3: { accessKeyId: string; secretAccessKey: string };
  }
}

let network: StartedNetwork | undefined;
let started: StartedTestContainer[] = [];

export default async function setup(project: TestProject) {
  const redisPassword = randomBytes(32).toString('hex');
  const s3Key = randomBytes(8).toString('hex');
  const s3Secret = randomBytes(16).toString('hex');
  network = await new Network().start();
  const [, pg, redis, s3] = await Promise.all([
    GenericContainer.fromDockerfile(ROOT, 'docker/backup/Dockerfile').build(AGENT_IMAGE, {
      deleteOnExit: false,
    }),
    new PostgreSqlContainer('postgres:17-alpine')
      .withNetwork(network)
      .withNetworkAliases('postgres')
      .start(),
    new GenericContainer('redis:7-alpine')
      .withCommand(['redis-server', '--requirepass', redisPassword, '--save', ''])
      .withNetwork(network)
      .withNetworkAliases('redis')
      .withExposedPorts(6379)
      .start(),
    new GenericContainer(S3_IMAGE)
      .withEnvironment({ S3_ACCESS_KEY_ID: s3Key, S3_SECRET_ACCESS_KEY: s3Secret })
      .withCopyFilesToContainer([
        { source: S3_ENTRYPOINT, target: '/s3-entrypoint.sh', mode: 0o755 },
      ])
      .withEntrypoint(['/s3-entrypoint.sh'])
      .withNetwork(network)
      .withNetworkAliases('s3')
      .withExposedPorts(8333)
      .withWaitStrategy(Wait.forHttp('/healthz', 8333))
      .start(),
  ]);
  started = [pg, redis, s3];
  project.provide('agentImage', AGENT_IMAGE);
  project.provide('network', network.getName());
  project.provide('pg', {
    host: pg.getHost(),
    port: pg.getPort(),
    user: pg.getUsername(),
    password: pg.getPassword(),
  });
  project.provide('redis', {
    password: redisPassword,
    url: `redis://:${redisPassword}@${redis.getHost()}:${redis.getMappedPort(6379)}`,
  });
  project.provide('s3', { accessKeyId: s3Key, secretAccessKey: s3Secret });
  return async () => {
    await Promise.all(started.map((c) => c.stop()));
    await network?.stop();
  };
}
