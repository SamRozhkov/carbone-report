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
/** Любой запрос не дольше 15 с: зависший port-forward не должен съедать таймаут задания. */
const TIMEOUT_MS = 15_000;
const get = (path: string) => fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });

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

/**
 * Запрос к API с cookie сессии. 503 повторяется до 15 с: реплика API держит флаг обслуживания
 * в кэше до секунды после снятия, и запрос через Service может попасть на неё (retry503 = false —
 * вернуть 503 сразу, для опроса операции во время восстановления).
 */
async function call(
  method: string,
  path: string,
  body?: unknown,
  retry503 = true,
): Promise<Response> {
  const until = Date.now() + 15_000;
  for (;;) {
    const headers = new Headers();
    if (cookie) headers.set('cookie', cookie);
    if (body !== undefined) headers.set('content-type', 'application/json');
    const r = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (r.status !== 503 || !retry503 || Date.now() > until) return r;
    await r.body?.cancel();
    await sleep(500);
  }
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
  const r = await call('GET', '/api/admin/backups/operation', undefined, false).catch(() => null);
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

/**
 * Флаг снят на всех репликах: не меньше 3 ответов active:false подряд на протяжении не меньше 2 с
 * (кэш флага в реплике — до 1 с, запросы через Service расходятся по репликам).
 */
async function waitMaintenanceCleared(timeoutMs: number): Promise<void> {
  const until = Date.now() + timeoutMs;
  let streak = 0;
  let since = 0;
  for (;;) {
    const r = await get('/api/maintenance').catch(() => null);
    const m = r?.status === 200 ? ((await r.json()) as Maintenance) : null;
    if (m && !m.active) {
      if (streak++ === 0) since = Date.now();
      if (streak >= 3 && Date.now() - since >= 2000) return;
    } else streak = 0;
    if (Date.now() > until)
      throw new Error(`режим обслуживания не снят устойчиво за ${timeoutMs / 1000} с`);
    await sleep(700);
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
    const r = await get('/api/health').catch(() => null);
    if (r?.status === 200) return;
    if (Date.now() > until) throw new Error(`/api/health: ${r?.status ?? 'нет соединения'}`);
    await sleep(2000);
  }
});

await step('SPA отдаётся с CSP', async () => {
  const r = await get('/');
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
  const beforeRestore = new Set(
    (await json<Backup[]>(await call('GET', '/api/admin/backups'), 200)).map((b) => b.name),
  );
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
    const r = await get('/api/maintenance').catch(() => null);
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
  await waitMaintenanceCleared(30_000);
  await login();
  const op = await waitOperation(operationId, 60_000);
  if (op.status !== 'succeeded') throw new Error(`восстановление: ${describe(op)}`);
  // Путь восстановления пройден целиком (и без замеченного флага): агент сделал бэкап pre-restore-*.
  const preRestore = (await json<Backup[]>(await call('GET', '/api/admin/backups'), 200)).find(
    (b) =>
      !beforeRestore.has(b.name) && b.kind === 'pre-restore' && b.name.startsWith('pre-restore-'),
  );
  if (!preRestore) throw new Error('после восстановления нет нового бэкапа pre-restore-*');
  const names = (await json<{ name: string }[]>(await call('GET', '/api/categories'), 200)).map(
    (c) => c.name,
  );
  if (!names.includes(kept)) throw new Error(`нет категории из бэкапа ${kept}`);
  if (names.includes(later)) throw new Error(`категория после бэкапа ${later} не исчезла`);
});

await step('режим обслуживания снят', async () => {
  const m = await json<Maintenance>(await get('/api/maintenance'), 200);
  if (m.active) throw new Error('cr:maintenance всё ещё установлен');
});

console.log('smoke пройден');
