import { ThemeProvider, Toaster, ToasterComponent, ToasterProvider } from '@gravity-ui/uikit';
import type { QueryClient } from '@tanstack/react-query';
import { QueryClientProvider } from '@tanstack/react-query';
import { render, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactElement, type ReactNode } from 'react';
import { createMemoryRouter, parsePath } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { vi } from 'vitest';
import { createQueryClient } from '../app/queryClient';
import { routes } from '../app/routes';

export interface MockRequest {
  url: URL;
  method: string;
  body: unknown;
}
export interface MockResponse {
  status?: number;
  body?: unknown;
  raw?: string;
  headers?: Record<string, string>;
}
export interface MockRoute extends MockResponse {
  method?: string;
  path: string;
  handler?: (req: MockRequest) => MockResponse;
}
export interface ApiCall {
  method: string;
  path: string;
  body: unknown;
}

function matches(pattern: string, pathname: string): boolean {
  const re = new RegExp(`^${pattern.replace(/:[^/]+/g, '[^/]+')}$`);
  return re.test(pathname);
}

/** Подменяет fetch: первый подходящий маршрут отвечает, остальное — 404. Вызовы пишутся в calls. */
export function mockApi(routes: MockRoute[]): { calls: ApiCall[] } {
  const calls: ApiCall[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input), 'http://localhost');
    const method = (init?.method ?? 'GET').toUpperCase();
    let body: unknown = undefined;
    if (typeof init?.body === 'string') body = JSON.parse(init.body);
    else if (init?.body !== undefined && init.body !== null) body = init.body;
    calls.push({ method, path: url.pathname + url.search, body });
    const route = routes.find(
      (r) => (r.method ?? 'GET').toUpperCase() === method && matches(r.path, url.pathname),
    );
    if (!route) {
      return new Response(
        JSON.stringify({
          error: { code: 'NOT_FOUND', message: `нет мока для ${method} ${url.pathname}` },
        }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      );
    }
    const out: MockResponse = route.handler ? route.handler({ url, method, body }) : route;
    const status = out.status ?? 200;
    if (status === 204) return new Response(null, { status });
    if (out.raw !== undefined) {
      return new Response(out.raw, {
        status,
        headers: { 'content-type': 'application/octet-stream', ...out.headers },
      });
    }
    return new Response(JSON.stringify(out.body ?? null), {
      status,
      headers: { 'content-type': 'application/json', ...out.headers },
    });
  });
  return { calls };
}

function Providers({ client, children }: { client: QueryClient; children: ReactNode }) {
  return (
    <ThemeProvider theme="light">
      <ToasterProvider toaster={new Toaster()}>
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
        <ToasterComponent />
      </ToasterProvider>
    </ThemeProvider>
  );
}

function testClient(): QueryClient {
  const client = createQueryClient();
  client.setDefaultOptions({
    queries: { retry: false, staleTime: 0 },
    mutations: { retry: false },
  });
  return client;
}

/** Провайдеры для renderHook (QueryClient без повторов, тостер). */
export function wrapper({ children }: { children: ReactNode }) {
  const [client] = useState(testClient);
  return <Providers client={client}>{children}</Providers>;
}

/** Рендер отдельного компонента (внутри MemoryRouter на `route`). */
export function renderWithProviders(
  ui: ReactElement,
  opts: { route?: string; path?: string } = {},
) {
  const client = testClient();
  const router = createMemoryRouter([{ path: opts.path ?? '*', element: ui }], {
    initialEntries: [opts.route ?? '/'],
  });
  const result = render(
    <Providers client={client}>
      <RouterProvider router={router} />
    </Providers>,
  );
  return { ...result, queryClient: client, router };
}

/** Рендер всего приложения (настоящие маршруты и guard'ы) на пути `path`; `state` — состояние перехода. */
export function renderRoute(path: string, state?: unknown) {
  const client = testClient();
  const router = createMemoryRouter(routes, { initialEntries: [{ ...parsePath(path), state }] });
  const result = render(
    <Providers client={client}>
      <RouterProvider router={router} />
    </Providers>,
  );
  return { ...result, queryClient: client, router };
}

export const adminMe = {
  path: '/api/auth/me',
  body: { id: 'admin-id', login: 'admin', role: 'admin' },
};
export const userMe = {
  path: '/api/auth/me',
  body: { id: 'user-id', login: 'ivanov', role: 'user' },
};

/**
 * Помощники для Select Gravity UI. Список рисуется в портале вне формы, а открытый диалог помечает
 * всё вне себя aria-hidden (floating-ui inert) — иногда уже после открытия списка, и тогда пункты
 * пропадают из поиска по ролям на всей странице. Поэтому пункты ищутся внутри самого списка
 * (aria-controls у поля) с учётом скрытых элементов.
 */

/** Открытый список поля или null. */
export function popupOf(combo: HTMLElement): HTMLElement | null {
  return document.getElementById(combo.getAttribute('aria-controls') ?? '');
}

/** Открывает список поля, если он закрыт, и ждёт, пока query найдёт в нём результат. */
async function inPopup<T>(combo: HTMLElement, query: (popup: HTMLElement) => T): Promise<T> {
  if (combo.getAttribute('aria-expanded') !== 'true') await userEvent.click(combo);
  return waitFor(() => {
    const popup = popupOf(combo);
    if (!popup) throw new Error('список не открыт');
    return query(popup);
  });
}

/** Все пункты списка поля; открывает список, если он закрыт. */
export function popupOptions(combo: HTMLElement): Promise<HTMLElement[]> {
  return inPopup(combo, (popup) => within(popup).getAllByRole('option', { hidden: true }));
}

/** Пункт списка поля по имени; открывает список, если он закрыт. */
export function findOption(combo: HTMLElement, name: string | RegExp): Promise<HTMLElement> {
  return inPopup(combo, (popup) => within(popup).getByRole('option', { name, hidden: true }));
}

/** Выбирает пункт списка поля. */
export async function pickOption(combo: HTMLElement, name: string | RegExp): Promise<void> {
  await userEvent.click(await findOption(combo, name));
}
