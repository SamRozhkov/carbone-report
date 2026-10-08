import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface Service {
  profiles?: string[];
  ports?: unknown;
  entrypoint?: unknown;
  command?: string[];
  build?: unknown;
  networks?: string[] | Record<string, { aliases?: string[] } | null>;
  volumes?: string[];
  healthcheck?: { test: string[] };
  environment: Record<string, string>;
}
const compose = parse(
  await readFile(new URL('../../../docker-compose.yml', import.meta.url), 'utf8'),
  {
    merge: true,
  },
) as { services: Record<string, Service>; networks: Record<string, unknown> };

describe('docker-compose.yml: агент бэкапа', () => {
  it('backup запускается со стеком: без профиля и портов, агент из образа, токен обязателен', () => {
    const b = compose.services.backup!;
    expect(b.profiles).toBeUndefined();
    expect(b.ports).toBeUndefined();
    expect(b.entrypoint).toBeUndefined();
    expect(b.command).toEqual(['agent']);
    expect(b.build).toEqual({ context: '.', dockerfile: 'docker/backup/Dockerfile' });
    expect(b.volumes).toEqual(['${BACKUP_DIR:-./backups}:/backups']);
    expect(b.environment.BACKUP_AGENT_TOKEN).toMatch(/^\$\{BACKUP_AGENT_TOKEN:\?/);
    expect(b.environment.REDIS_URL).toMatch(/^redis:\/\/:\$\{REDIS_PASSWORD:\?[^}]*\}@redis:6379$/);
    expect(compose.networks.backup).toEqual({ internal: true });
  });

  it('§26.1: HTTP агента — только в сети backup (псевдоним backup-agent есть только там)', () => {
    const b = compose.services.backup!;
    expect(b.networks).toEqual({
      default: null,
      s3: null,
      cache: null,
      backup: { aliases: ['backup-agent'] },
    });
    expect(b.environment.BACKUP_AGENT_HOST).toBe('backup-agent');
    // Агент не слушает 127.0.0.1 — проверка здоровья идёт по тому же адресу в сети backup.
    expect(b.healthcheck?.test).toContain('http://backup-agent:8080/health');
  });

  it('api знает адрес и токен агента и подключён к сети backup', () => {
    const a = compose.services.api!;
    expect(a.environment.BACKUP_AGENT_URL).toBe('http://backup-agent:8080');
    expect(a.environment.BACKUP_AGENT_TOKEN).toMatch(/^\$\{BACKUP_AGENT_TOKEN:\?/);
    expect(a.networks).toContain('backup');
  });

  it('redis — только во внутренней сети cache', () => {
    expect(compose.services.redis!.networks).toEqual(['cache']);
  });
});
