import {
  test as base,
  expect,
  request,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from '@playwright/test';
import { createRequire } from 'node:module';
import type JSZipType from 'jszip';

// jszip (CommonJS с циклическими require) через ESM-загрузчик Playwright падает в Node 22
// («Unexpected module status 3»), поэтому грузим его обычным require.
const JSZip = createRequire(import.meta.url)('jszip') as typeof JSZipType;

export { expect };

export const ADMIN = {
  login: process.env.ADMIN_LOGIN ?? 'admin',
  password: process.env.ADMIN_PASSWORD ?? '',
};
const BASE = process.env.BASE_URL ?? `https://localhost:${process.env.WEB_HTTPS_PORT ?? 443}`;

interface Violation {
  frame: string;
  directive: string;
  blocked: string;
  source: string;
}

/**
 * page с проверкой CSP: события securitypolicyviolation во всех фреймах + сообщения консоли.
 * Нарушения передаются в тест сразу через binding, поэтому не теряются при переходах между страницами.
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    const violations: Violation[] = [];
    await page.exposeBinding('__cspViolation', ({ frame }, v: Omit<Violation, 'frame'>) => {
      violations.push({ frame: frame.url(), ...v });
    });
    await page.addInitScript(() => {
      const report = (window as unknown as { __cspViolation: (v: unknown) => void }).__cspViolation;
      document.addEventListener('securitypolicyviolation', (e) => {
        void report({
          directive: e.violatedDirective,
          blocked: e.blockedURI,
          source: `${e.sourceFile}:${e.lineNumber}`,
        });
      });
    });
    const consoleCsp: string[] = [];
    page.on('console', (m) => {
      if (/Content[- ]Security[- ]Policy/i.test(m.text())) {
        consoleCsp.push(`${m.location().url || page.url()}: ${m.text()}`);
      }
    });
    await use(page);
    expect([...violations, ...consoleCsp], 'нарушения Content-Security-Policy').toEqual([]);
  },
});

export async function loginUi(page: Page, login: string, password: string): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Логин').fill(login);
  await page.getByLabel('Пароль').fill(password);
  await page.getByRole('button', { name: 'Войти' }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

export async function logoutUi(page: Page): Promise<void> {
  await page.getByText('Выйти', { exact: true }).click();
  await expect(page).toHaveURL(/\/login/);
}

export interface ApiClient {
  ctx: APIRequestContext;
  get<T>(path: string): Promise<T>;
  post<T>(path: string, data?: unknown): Promise<T>;
  put<T>(path: string, data: unknown): Promise<T>;
  patch<T>(path: string, data: unknown): Promise<T>;
  del(path: string): Promise<void>;
  /** Запрос без проверки статуса: для негативных сценариев. */
  raw(path: string, init?: Parameters<APIRequestContext['fetch']>[1]): Promise<APIResponse>;
}

export async function adminApi(): Promise<ApiClient> {
  const ctx = await request.newContext({ baseURL: BASE, ignoreHTTPSErrors: true });
  const res = await ctx.post('/api/auth/login', { data: ADMIN });
  expect(res.ok(), `вход админа через API: ${res.status()}`).toBeTruthy();
  const call = async <T>(
    method: 'get' | 'post' | 'put' | 'patch' | 'delete',
    path: string,
    data?: unknown,
  ) => {
    const r = await ctx[method](path, data === undefined ? {} : { data });
    expect(r.ok(), `${method.toUpperCase()} ${path}: ${r.status()} ${await r.text()}`).toBeTruthy();
    const text = await r.text();
    return (text ? JSON.parse(text) : undefined) as T;
  };
  return {
    ctx,
    get: (p) => call('get', p),
    post: (p, d) => call('post', p, d),
    put: (p, d) => call('put', p, d),
    patch: (p, d) => call('patch', p, d),
    del: async (p) => void (await call('delete', p)),
    raw: (p, init) => ctx.fetch(p, init),
  };
}

export async function demoTemplateId(api: ApiClient): Promise<string> {
  const list = await api.get<{ id: string; name: string }[]>('/api/templates');
  const t = list.find((x) => x.name === 'Счёт (демо)');
  expect(t, 'нет шаблона «Счёт (демо)» — запустите pnpm stack:demo').toBeTruthy();
  return t!.id;
}

/** Текст DOCX без разметки (по word/document.xml). */
export async function docxText(buf: Buffer): Promise<string> {
  const xml = await (await JSZip.loadAsync(buf)).file('word/document.xml')!.async('string');
  return xml.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
}

/** Готовность стека: API и Document Server. */
export async function waitForStack(): Promise<void> {
  const ctx = await request.newContext({ baseURL: BASE, ignoreHTTPSErrors: true });
  await expect
    .poll(async () => (await ctx.get('/api/health').catch(() => null))?.ok() ?? false, {
      timeout: 180_000,
    })
    .toBe(true);
  await expect
    .poll(
      async () =>
        (await (await ctx.get('/onlyoffice/healthcheck').catch(() => null))?.text())?.trim(),
      {
        timeout: 300_000,
      },
    )
    .toBe('true');
  await ctx.dispose();
}
