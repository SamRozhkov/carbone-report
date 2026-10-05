// Наполнение демо-данными через публичный API. Запуск: pnpm demo:seed [-- --reset-template]
import { buildDemoTemplate, DEMO, DEMO_PARAMS, DEMO_QUERIES } from '../demo/template';

if (process.argv.includes('--insecure')) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
try {
  process.loadEnvFile('.env');
} catch {
  // переменные могут прийти из окружения
}

const BASE = (
  process.env.BASE_URL ?? `https://localhost:${process.env.WEB_HTTPS_PORT ?? 443}`
).replace(/\/$/, '');
const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`не задана переменная ${k}`);
  return v;
};
let cookie = '';

async function call<T>(
  method: string,
  path: string,
  body?: unknown,
  expected = [200, 201, 204],
): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (cookie) headers.cookie = cookie;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, { method, headers, body: payload });
  const text = await res.text();
  if (!expected.includes(res.status))
    throw new Error(`${method} ${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
  if (res.headers.get('set-cookie')) cookie = res.headers.get('set-cookie')!.split(';')[0]!;
  return (text ? JSON.parse(text) : undefined) as T;
}

async function waitForStack(): Promise<void> {
  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {
      // стек ещё поднимается
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error(`стек не ответил за 5 минут: ${BASE}/api/health`);
}

const docxForm = async (extra: Record<string, string>) => {
  const form = new FormData();
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  form.append('file', new Blob([new Uint8Array(await buildDemoTemplate())]), 'schet-demo.docx');
  return form;
};

async function main() {
  if (process.argv.includes('--wait')) await waitForStack();
  await call('POST', '/api/auth/login', {
    login: need('ADMIN_LOGIN'),
    password: need('ADMIN_PASSWORD'),
  });

  type Ds = { id: string; name: string };
  const sources = await call<Ds[]>('GET', '/api/datasources');
  let ds = sources.find((s) => s.name === DEMO.datasourceName);
  const dsBody = {
    name: DEMO.datasourceName,
    host: 'demo-db',
    port: 5432,
    database: 'demo',
    username: 'demo_ro',
    password: need('DEMO_DB_PASSWORD'),
    sslMode: 'disable',
  };
  if (!ds) {
    ds = await call<Ds>('POST', '/api/datasources', dsBody);
    console.log(`✓ источник «${ds.name}» создан`);
  } else {
    await call('PATCH', `/api/datasources/${ds.id}`, dsBody);
    console.log(`✓ источник «${ds.name}» обновлён`);
  }
  const test = await call<{ ok: boolean; message?: string }>(
    'POST',
    `/api/datasources/${ds.id}/test`,
  );
  if (!test.ok) throw new Error(`демо-база недоступна: ${test.message}`);

  type Tpl = { id: string; name: string };
  const templates = await call<Tpl[]>('GET', '/api/templates');
  let tpl = templates.find((t) => t.name === DEMO.templateName);
  if (!tpl) {
    tpl = await call<Tpl>(
      'POST',
      '/api/templates/upload',
      await docxForm({
        name: DEMO.templateName,
        description: 'Демонстрационный счёт: реквизиты компании и позиции из демо-базы',
        datasourceId: ds.id,
      }),
    );
    console.log(`✓ шаблон «${tpl.name}» загружен`);
  } else if (process.argv.includes('--reset-template')) {
    await call('PUT', `/api/templates/${tpl.id}/file`, await docxForm({}));
    console.log(`✓ файл шаблона «${tpl.name}» восстановлен`);
  }
  await call('PATCH', `/api/templates/${tpl.id}`, { datasourceId: ds.id, defaultOutput: 'pdf' });
  await call('PUT', `/api/templates/${tpl.id}/params`, DEMO_PARAMS);
  await call('PUT', `/api/templates/${tpl.id}/queries`, DEMO_QUERIES);
  console.log(`✓ запросы и параметры шаблона приведены к эталону (id ${tpl.id})`);
}

main().catch((e) => {
  console.error(`✗ ${(e as Error).message}`);
  process.exit(1);
});
