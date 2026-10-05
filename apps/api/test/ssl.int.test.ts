import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testConnection } from '../src/modules/datasources/pools';

let pg: StartedTestContainer;
let ca: string;
const PASSWORD = 'ssl-test-password';

beforeAll(async () => {
  // debian-образ: в alpine нет openssl CLI
  pg = await new GenericContainer('postgres:17-bookworm')
    .withEnvironment({ POSTGRES_PASSWORD: PASSWORD })
    .withExposedPorts(5432)
    .withEntrypoint(['bash', '-c'])
    .withCommand([
      [
        'set -e',
        'mkdir -p /certs',
        'openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=localhost" ' +
          '-addext "subjectAltName=DNS:localhost" ' +
          '-keyout /certs/server.key -out /certs/server.crt',
        'chown postgres:postgres /certs/server.key /certs/server.crt',
        'chmod 600 /certs/server.key',
        'exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/certs/server.crt -c ssl_key_file=/certs/server.key',
      ].join(' && '),
    ])
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  const out = (await pg.exec(['cat', '/certs/server.crt'])).output;
  ca = out.slice(
    out.indexOf('-----BEGIN CERTIFICATE-----'),
    out.indexOf('-----END CERTIFICATE-----') + 25,
  );
}, 120_000);
afterAll(() => pg?.stop());

const conn = (
  sslMode: 'disable' | 'require' | 'verify',
  sslCa: string | null,
  host = 'localhost',
) => ({
  host,
  port: pg.getMappedPort(5432),
  database: 'postgres',
  username: 'postgres',
  password: PASSWORD,
  sslMode,
  sslCa,
});

describe('SSL источников', () => {
  it('require подключается к серверу с самоподписанным сертификатом', async () => {
    expect(await testConnection(conn('require', null))).toEqual({ ok: true });
  });
  it('verify без CA отклоняет самоподписанный сертификат с понятной ошибкой', async () => {
    const r = await testConnection(conn('verify', null));
    expect(r.ok).toBe(false);
    expect((r as { message: string }).message).toMatch(/^сертификат не прошёл проверку: /);
  });
  it('verify с CA подключается', async () => {
    expect(await testConnection(conn('verify', ca))).toEqual({ ok: true });
  });
  it('verify с CA, но чужим именем хоста — ошибка проверки', async () => {
    // 127.0.0.1 нет в SAN сертификата (только DNS:localhost), маршрут тот же, что у localhost.
    const r = await testConnection(conn('verify', ca, '127.0.0.1'));
    expect(r.ok).toBe(false);
    expect((r as { message: string }).message).toMatch(
      /^сертификат не прошёл проверку: .*altnames/,
    );
  });
});
