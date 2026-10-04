// Сквозная проверка работающего стека через nginx. Запуск: pnpm stack:smoke [--insecure]
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import JSZip from 'jszip';
import { SignJWT } from 'jose';

if (process.argv.includes('--insecure')) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
try {
  process.loadEnvFile('.env');
} catch {
  // .env может отсутствовать, если переменные заданы окружением
}

const BASE = (process.env.BASE_URL ?? 'http://localhost:8080').replace(/\/$/, '');
const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`не задана переменная ${k}`);
  return v;
};

let cookie = '';
let failed = 0;
const cleanup: (() => Promise<unknown>)[] = [];

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (cookie) headers.set('cookie', cookie);
  return fetch(`${BASE}${path}`, { ...init, headers, redirect: 'manual' });
}

async function json<T = unknown>(res: Response, expected = 200): Promise<T> {
  const text = await res.text();
  if (res.status !== expected)
    throw new Error(`HTTP ${res.status}, ожидался ${expected}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  const t = Date.now();
  try {
    await fn();
    console.log(`✓ ${name} (${Date.now() - t} мс)`);
  } catch (e) {
    failed++;
    console.log(`✗ ${name}: ${(e as Error).message}`);
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function docxWithTag(): Promise<Buffer> {
  const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip.file(
    '_rels/.rels',
    `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  zip.file(
    'word/document.xml',
    `${XML}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Компания: {d.company.name}</w:t></w:r></w:p></w:body></w:document>`,
  );
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function main() {
  console.log(`Smoke-проверка ${BASE}`);
  let templateId = '';
  let datasourceId = '';

  await step('интерфейс отдаётся с заголовками безопасности', async () => {
    const r = await fetch(`${BASE}/some/spa/route`);
    assert(r.status === 200, `HTTP ${r.status}`);
    const html = await r.text();
    assert(html.includes('<div id="root">'), 'нет корня SPA');
    assert(r.headers.get('x-content-type-options') === 'nosniff', 'нет X-Content-Type-Options');
    assert(
      r.headers.get('content-security-policy-report-only')?.includes("default-src 'self'"),
      'нет CSP',
    );
    const script = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
    assert(script, 'не найден JS-бандл');
    const js = await fetch(`${BASE}${script}`);
    assert(
      js.status === 200 && (js.headers.get('cache-control') ?? '').includes('immutable'),
      'ассеты не кэшируются',
    );
  });

  await step('health через nginx', async () => {
    const b = await json<{ status: string }>(await api('/api/health'));
    assert(b.status === 'ok', `status=${b.status}`);
  });

  await step('/internal закрыт снаружи', async () => {
    const r = await api('/internal/templates/00000000-0000-0000-0000-000000000000/file');
    assert(r.status === 404, `HTTP ${r.status}`);
  });

  await step('/internal закрыт и для закодированных путей', async () => {
    const u = new URL(BASE);
    const rawPath = '/internal/templates/x%2F..%2F..%2F..%2Fapi%2F/file';
    const status = await new Promise<number>((resolve, reject) => {
      const req = (u.protocol === 'https:' ? https : http).request(
        {
          hostname: u.hostname,
          port: u.port || undefined,
          path: rawPath,
          method: 'GET',
          rejectUnauthorized: process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0',
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert(status === 404, `HTTP ${status}`);
  });

  await step('вход админа', async () => {
    const r = await api('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: need('ADMIN_LOGIN'), password: need('ADMIN_PASSWORD') }),
    });
    await json(r);
    cookie = (r.headers.get('set-cookie') ?? '').split(';')[0]!;
    assert(cookie.startsWith('session='), 'нет cookie session');
  });

  await step('источник данных на postgres', async () => {
    const ds = await json<{ id: string }>(
      await api('/api/datasources', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: `smoke ${randomUUID().slice(0, 6)}`,
          host: 'postgres',
          port: 5432,
          database: 'app',
          username: 'app',
          password: need('POSTGRES_PASSWORD'),
          ssl: false,
        }),
      }),
      201,
    );
    datasourceId = ds.id;
    cleanup.push(() => api(`/api/datasources/${datasourceId}`, { method: 'DELETE' }));
    const test = await json<{ ok: boolean; message?: string }>(
      await api(`/api/datasources/${datasourceId}/test`, { method: 'POST' }),
    );
    assert(test.ok, `проверка соединения: ${test.message}`);
  });

  await step('загрузка шаблона и запрос', async () => {
    const form = new FormData();
    form.append('name', 'Smoke-шаблон');
    form.append('description', '');
    form.append('datasourceId', datasourceId);
    form.append('file', new Blob([new Uint8Array(await docxWithTag())]), 'smoke.docx');
    const t = await json<{ id: string }>(
      await api('/api/templates/upload', { method: 'POST', body: form }),
      201,
    );
    templateId = t.id;
    cleanup.unshift(() => api(`/api/templates/${templateId}`, { method: 'DELETE' }));
    await json(
      await api(`/api/templates/${templateId}/queries`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify([
          { key: 'company', mode: 'single', sql: "select 'ООО Ромашка' as name" },
        ]),
      }),
    );
  });

  async function renderTo(format: 'pdf' | 'docx'): Promise<Buffer> {
    const { runId } = await json<{ runId: string }>(
      await api(`/api/reports/${templateId}/render`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ params: {}, format }),
      }),
      201,
    );
    const r = await api(`/api/runs/${runId}/file`);
    assert(r.status === 200, `скачивание: HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }

  await step('Carbone: DOCX с подставленными данными', async () => {
    const zip = await JSZip.loadAsync(await renderTo('docx'));
    const xml = await zip.file('word/document.xml')!.async('string');
    assert(xml.includes('ООО Ромашка'), 'в документе нет «ООО Ромашка»');
    assert(!xml.includes('{d.company.name}'), 'тег не заменён');
  });

  await step('Carbone: PDF', async () => {
    const pdf = await renderTo('pdf');
    assert(pdf.subarray(0, 4).toString() === '%PDF', 'файл не PDF');
  });

  await step('OnlyOffice: healthcheck и api.js через nginx', async () => {
    const h = await api('/onlyoffice/healthcheck');
    assert(h.status === 200 && (await h.text()).trim() === 'true', `healthcheck HTTP ${h.status}`);
    const js = await api('/onlyoffice/web-apps/apps/api/documents/api.js');
    assert(js.status === 200, `api.js HTTP ${js.status}`);
  });

  await step('OnlyOffice → api: конвертация шаблона по внутреннему URL', async () => {
    const cfg = await json<{ document: { url: string } }>(
      await api(`/api/templates/${templateId}/editor-config`),
    );
    const body = {
      async: false,
      filetype: 'docx',
      outputtype: 'pdf',
      key: randomUUID().replaceAll('-', ''),
      title: 'smoke.docx',
      url: cfg.document.url,
    };
    const secret = new TextEncoder().encode(need('ONLYOFFICE_JWT_SECRET'));
    const token = await new SignJWT(body)
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .sign(secret);
    const r = await fetch(`${BASE}/onlyoffice/converter`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ ...body, token }),
    });
    const res = (await r.json()) as { endConvert?: boolean; fileUrl?: string; error?: number };
    assert(res.endConvert && res.fileUrl, `ответ конвертера: ${JSON.stringify(res)}`);
    const file = await fetch(res.fileUrl);
    assert(file.status === 200, `fileUrl ${res.fileUrl}: HTTP ${file.status}`);
    assert(
      Buffer.from(await file.arrayBuffer())
        .subarray(0, 4)
        .toString() === '%PDF',
      'результат конвертации не PDF',
    );
  });

  for (const fn of cleanup) {
    await fn().catch(() => undefined);
  }

  console.log(failed === 0 ? '\nВсе проверки пройдены.' : `\nПровалено проверок: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
