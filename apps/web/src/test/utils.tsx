import { ThemeProvider, Toaster, ToasterComponent, ToasterProvider } from '@gravity-ui/uikit';
import type { QueryClient } from '@tanstack/react-query';
import { QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { createMemoryRouter } from 'react-router';
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

/** Рендер всего приложения (настоящие маршруты и guard'ы) на пути `path`. */
export function renderRoute(path: string) {
  const client = testClient();
  const router = createMemoryRouter(routes, { initialEntries: [path] });
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
