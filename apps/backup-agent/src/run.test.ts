import { describe, expect, it } from 'vitest';
import { createRedactor } from './redact';
import { childEnv, run } from './run';

describe('run', () => {
  it('строки stdout и stderr идут в out через фильтр секретов; код 0 — успех', async () => {
    const lines: string[] = [];
    const env = { PATH: process.env.PATH, PGPASSWORD: 'pg-pass-123' };
    await run('sh', ['-c', 'echo начало; echo "пароль $PGPASSWORD" >&2'], {
      env,
      out: (l) => lines.push(l),
      redact: createRedactor(env),
    });
    expect(lines.sort()).toEqual(['начало', 'пароль ***'].sort());
  });

  it('ненулевой код — ошибка с последней непустой строкой вывода (без секретов)', async () => {
    const env = { PATH: process.env.PATH, S3_SECRET_ACCESS_KEY: 'secretkey' };
    await expect(
      run('sh', ['-c', 'echo "нет доступа: secretkey" >&2; exit 3'], {
        env,
        out: () => {},
        redact: createRedactor(env),
      }),
    ).rejects.toThrow('sh: нет доступа: ***');
  });

  it('без вывода — код возврата в сообщении', async () => {
    await expect(
      run('sh', ['-c', 'exit 4'], {
        env: { PATH: process.env.PATH },
        out: () => {},
        redact: (s) => s,
      }),
    ).rejects.toThrow('sh: код 4');
  });
});

describe('childEnv', () => {
  it('без токена агента и REDIS_URL; умолчания PG* как в backup.sh; extra перекрывает', () => {
    const env = childEnv(
      {
        BACKUP_AGENT_TOKEN: 't'.repeat(32),
        REDIS_URL: 'redis://:p@r',
        PGPASSWORD: 'x',
        PGHOST: 'db',
      },
      { BACKUP_NAME: 'pre-restore-2026-10-08T10-00-00Z' },
    );
    expect(env).not.toHaveProperty('BACKUP_AGENT_TOKEN');
    expect(env).not.toHaveProperty('REDIS_URL');
    expect(env).toMatchObject({
      PGHOST: 'db',
      PGUSER: 'app',
      PGDATABASE: 'app',
      PGPASSWORD: 'x',
      BACKUP_NAME: 'pre-restore-2026-10-08T10-00-00Z',
    });
  });
});
