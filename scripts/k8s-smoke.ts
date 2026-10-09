// Smoke установки чарта (CI, задание chart-kind; §27.9) через port-forward к web:
//   BASE_URL=http://127.0.0.1:8080 ADMIN_LOGIN=… ADMIN_PASSWORD=… pnpm exec tsx scripts/k8s-smoke.ts
// Проверяет: health и CSP через nginx, вход, бэкап из админки, восстановление с режимом обслуживания,
// данные из бэкапа после повторного входа. Первая ошибка останавливает проверку (код 1).
// Пароль и cookie сессии в вывод не попадают.
import { randomUUID } from 'node:crypto';

const BASE = (process.env.BASE_URL ?? 'http://127.0.0.1:8080').replace(/\/$/, '');
const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`не задана переменная ${k}`);
  return v;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Operation {
  id: string;
  status: string;
  phase?: string;
  error?: string | null;
}
interface Backup {
  name: string;
  kind: string;
  status: string;
}
interface Maintenance {
  active: boolean;
  phase?: string;
  recovery?: unknown;
}

let cookie = '';

async function call(method: string, path: string, body?: unknown): Promise<Response> {
  const headers = new Headers();
  if (cookie) headers.set('cookie', cookie);
  if (body !== undefined) headers.set('content-type', 'application/json');
  return fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'manual',
  });
}

async function json<T>(res: Response, expected: number): Promise<T> {
  const text = await res.text();
  if (res.status !== expected)
    throw new Error(`${res.url}: HTTP ${res.status}, ожидался ${expected}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  const t = Date.now();
  try {
    await fn();
    console.log(`✓ ${name} (${Date.now() - t} мс)`);
  } catch (e) {
    console.error(`✗ ${name}: ${(e as Error).message}`);
    process.exit(1);
  }
}

async function login(): Promise<void> {
  cookie = '';
  const r = await call('POST', '/api/auth/login', {
    login: need('ADMIN_LOGIN'),
    password: need('ADMIN_PASSWORD'),
  });
  if (r.status !== 200) throw new Error(`вход: HTTP ${r.status}`);
  cookie = (r.headers.get('set-cookie') ?? '').split(';')[0]!;
  if (!cookie.startsWith('session=')) throw new Error('нет cookie session');
}

/** Текущая операция агента, если это операция id и она завершена; иначе null. 401 — повторный вход. */
async function finishedOperation(id: string): Promise<Operation | null> {
  const r = await call('GET', '/api/admin/backups/operation').catch(() => null);
  if (r?.status === 401) await login().catch(() => {});
  else if (r?.status === 200) {
    const op = (await r.json()) as Operation;
    if (op.id === id && op.status !== 'running') return op;
  }
  return null;
}

/** Ждёт конца операции с этим id; ответы не 200 (503 во время восстановления) пропускаются. */
async function waitOperation(id: string, timeoutMs: number): Promise<Operation> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const op = await finishedOperation(id);
    if (op) return op;
    if (Date.now() > until)
      throw new Error(`операция ${id} не завершилась за ${timeoutMs / 1000} с`);
    await sleep(2000);
  }
}

const describe = (op: Operation) =>
  `${op.status} (фаза ${op.phase ?? '?'}${op.error ? `: ${op.error}` : ''})`;

const suffix = randomUUID().slice(0, 8);
const kept = `k8s-smoke-бэкап-${suffix}`;
const later = `k8s-smoke-после-${suffix}`;
let backupName = '';

await step('API отвечает через web', async () => {
  const until = Date.now() + 60_000;
  for (;;) {
    const r = await fetch(`${BASE}/api/health`).catch(() => null);
    if (r?.status === 200) return;
    if (Date.now() > until) throw new Error(`/api/health: ${r?.status ?? 'нет соединения'}`);
    await sleep(2000);
  }
});

await step('SPA отдаётся с CSP', async () => {
  const r = await fetch(`${BASE}/`);
  if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
  const csp = r.headers.get('content-security-policy') ?? '';
  if (!csp.includes("default-src 'self'")) throw new Error(`нет CSP: «${csp}»`);
});

await step('вход администратора, бэкапы включены', async () => {
  await login();
  const me = await json<{ features?: { backups?: boolean } }>(
    await call('GET', '/api/auth/me'),
    200,
  );
  if (me.features?.backups !== true)
    throw new Error('features.backups не true: у api нет BACKUP_AGENT_URL');
});

await step('бэкап из админки', async () => {
  await json(await call('POST', '/api/categories', { name: kept }), 201);
  const before = new Set(
    (await json<Backup[]>(await call('GET', '/api/admin/backups'), 200)).map((b) => b.name),
  );
  const { operationId } = await json<{ operationId: string }>(
    await call('POST', '/api/admin/backups', {}),
    202,
  );
  const op = await waitOperation(operationId, 300_000);
  if (op.status !== 'succeeded') throw new Error(`бэкап: ${describe(op)}`);
  const created = (await json<Backup[]>(await call('GET', '/api/admin/backups'), 200)).find(
    (b) => !before.has(b.name) && b.kind === 'regular',
  );
  if (!created || created.status !== 'ok') throw new Error('новый бэкап не найден в списке');
  backupName = created.name;
});

await step('восстановление: режим обслуживания, затем данные из бэкапа', async () => {
  await json(await call('POST', '/api/categories', { name: later }), 201);
  const { operationId } = await json<{ operationId: string }>(
    await call('POST', `/api/admin/backups/${encodeURIComponent(backupName)}/restore`, {}),
    202,
  );
  // Флаг обслуживания виден всем репликам API, пока идёт восстановление: включается после бэкапа
  // pre-restore и держится всю замену базы. Опрос раз в секунду; если флаг проскочил между опросами,
  // выходим по завершённой операции и снятому флагу, а пропуск печатаем предупреждением.
  let sawMaintenance = false;
  const until = Date.now() + 600_000;
  for (;;) {
    const r = await fetch(`${BASE}/api/maintenance`).catch(() => null);
    if (r?.status === 200) {
      const m = (await r.json()) as Maintenance;
      if (m.active) {
        sawMaintenance = true;
        // recovery — восстановление упало и ждёт кода восстановления: ждать дальше бессмысленно.
        if (m.recovery)
          throw new Error(`восстановление упало на фазе ${m.phase ?? '?'}, требуется код`);
      } else if (sawMaintenance) break;
      else if (await finishedOperation(operationId)) break;
    }
    if (Date.now() > until) throw new Error('режим обслуживания не снят за 10 минут');
    await sleep(1000);
  }
  if (!sawMaintenance)
    console.warn('⚠ режим обслуживания не замечен опросом: восстановление прошло между опросами');
  await login();
  const op = await waitOperation(operationId, 60_000);
  if (op.status !== 'succeeded') throw new Error(`восстановление: ${describe(op)}`);
  const names = (await json<{ name: string }[]>(await call('GET', '/api/categories'), 200)).map(
    (c) => c.name,
  );
  if (!names.includes(kept)) throw new Error(`нет категории из бэкапа ${kept}`);
  if (names.includes(later)) throw new Error(`категория после бэкапа ${later} не исчезла`);
});

await step('режим обслуживания снят', async () => {
  const m = await json<Maintenance>(await fetch(`${BASE}/api/maintenance`), 200);
  if (m.active) throw new Error('cr:maintenance всё ещё установлен');
});

console.log('smoke пройден');
