import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GenericContainer,
  Network,
  Wait,
  type StartedNetwork,
  type StartedTestContainer,
} from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const IMAGE = 'carbone-reports-web-nginx:it';
const INDEX = '<!doctype html><title>stub</title>';

let network: StartedNetwork;
let upstream: StartedTestContainer;
const started: StartedTestContainer[] = [];
let certs: string;

/** Заглушка API и OnlyOffice: nginx отвечает своим именем на любой путь. */
const STUB_CONF = `server {
  listen 3000; location / { return 200 "api-stub $request_uri"; }
}
server {
  listen 80; location / { return 200 "oo-stub $request_uri"; }
}`;

beforeAll(async () => {
  await GenericContainer.fromDockerfile(ROOT, 'docker/web.Dockerfile')
    .withBuildkit()
    .withTarget('nginx')
    .build(IMAGE, { deleteOnExit: false });
  network = await new Network().start();
  // Имена как в k8s: полное имя сервиса с точками (резолвер nginx не применяет домены поиска).
  upstream = await new GenericContainer('nginx:1.30-alpine')
    .withCopyContentToContainer([{ content: STUB_CONF, target: '/etc/nginx/conf.d/default.conf' }])
    .withNetwork(network)
    .withNetworkAliases(
      'cr-api.ns.svc.cluster.local',
      'cr-onlyoffice.ns.svc.cluster.local',
      'api',
      'onlyoffice',
    )
    .start();
  certs = mkdtempSync(join(tmpdir(), 'web-certs-'));
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-keyout',
      join(certs, 'privkey.pem'),
      '-out',
      join(certs, 'fullchain.pem'),
    ],
    { stdio: 'ignore' },
  );
}, 600_000);

afterAll(async () => {
  await Promise.all(started.map((c) => c.stop()));
  await upstream?.stop();
  await network?.stop();
  if (certs) rmSync(certs, { recursive: true, force: true });
});

async function web(env: Record<string, string>, opts: { tls?: boolean } = {}) {
  let c = new GenericContainer(IMAGE)
    .withEnvironment(env)
    .withNetwork(network)
    .withCopyContentToContainer([{ content: INDEX, target: '/usr/share/nginx/html/index.html' }])
    .withExposedPorts(...(opts.tls ? [80, 443] : [80]))
    .withWaitStrategy(Wait.forListeningPorts());
  if (opts.tls)
    c = c.withCopyFilesToContainer([
      { source: join(certs, 'fullchain.pem'), target: '/etc/nginx/certs/fullchain.pem' },
      { source: join(certs, 'privkey.pem'), target: '/etc/nginx/certs/privkey.pem' },
    ]);
  const s = await c.start();
  started.push(s);
  return s;
}
const url = (c: StartedTestContainer, port: number, path: string) =>
  `http://${c.getHost()}:${c.getMappedPort(port)}${path}`;

describe('образ web: nginx', () => {
  it('http (k8s): /api и /onlyoffice по полным именам сервисов, резолвер из resolv.conf, HSTS, CSP', async () => {
    const c = await web({
      NGINX_MODE: 'http',
      API_UPSTREAM: 'http://cr-api.ns.svc.cluster.local:3000',
      ONLYOFFICE_UPSTREAM: 'http://cr-onlyoffice.ns.svc.cluster.local',
    });
    const api = await fetch(url(c, 80, '/api/health'));
    expect(await api.text()).toBe('api-stub /api/health');
    expect(api.headers.get('strict-transport-security')).toBe('max-age=31536000');
    const oo = await fetch(url(c, 80, '/onlyoffice/healthcheck'));
    expect(await oo.text()).toBe('oo-stub /healthcheck');
    const page = await fetch(url(c, 80, '/'), { redirect: 'manual' });
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(page.headers.get('strict-transport-security')).toBe('max-age=31536000');
    expect((await fetch(url(c, 80, '/internal/x'))).status).toBe(404);
    const conf = await c.exec(['cat', '/etc/nginx/snippets/common.conf']);
    const ns = (
      await c.exec(['awk', '$1 == "nameserver" { print $2; exit }', '/etc/resolv.conf'])
    ).output.trim();
    expect(conf.output).toContain(`resolver ${ns} valid=10s ipv6=off;`);
    // Переменные nginx не тронуты envsubst.
    expect(conf.output).toContain('proxy_set_header Host $http_host;');
  });

  it('tls (compose, по умолчанию): 80 → 301 на https, 443 с сертификатами, адреса api/onlyoffice по умолчанию', async () => {
    const c = await web({}, { tls: true });
    const plain = await fetch(url(c, 80, '/x'), { redirect: 'manual' });
    expect(plain.status).toBe(301);
    const body = await new Promise<string>((resolve, reject) => {
      https
        .get(
          {
            host: c.getHost(),
            port: c.getMappedPort(443),
            path: '/api/me',
            rejectUnauthorized: false,
          },
          (res) => {
            let s = '';
            res.on('data', (d) => (s += d));
            res.on('end', () => resolve(s));
          },
        )
        .on('error', reject);
    });
    expect(body).toBe('api-stub /api/me');
  });

  it('dev: только HTTP, без HSTS', async () => {
    const c = await web({ NGINX_MODE: 'dev' });
    const page = await fetch(url(c, 80, '/'));
    expect(page.status).toBe(200);
    expect(page.headers.get('strict-transport-security')).toBeNull();
  });

  it('неверный NGINX_MODE — понятная ошибка и ненулевой код', async () => {
    const c = await web({ NGINX_MODE: 'http' });
    const r = await c.exec([
      'sh',
      '-c',
      'NGINX_MODE=bogus; . /docker-entrypoint.d/15-carbone-reports.envsh; echo "rc=$?"',
    ]);
    expect(r.output).toContain('NGINX_MODE: ожидается tls, http или dev');
    expect(r.output).not.toContain('rc=0');
  });

  it('шаблон и режимы в репозитории — те же файлы, что копирует Dockerfile', () => {
    const df = readFileSync(join(ROOT, 'docker/web.Dockerfile'), 'utf8');
    for (const f of [
      'templates/',
      'server-tls.conf',
      'server-http.conf',
      'server-dev.conf',
      '15-carbone-reports.envsh',
    ])
      expect(df).toContain(`docker/nginx/${f}`);
  });
});
