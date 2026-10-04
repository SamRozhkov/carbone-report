import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { ApiRequestError } from '../api/client';
import { meKey } from '../api/session';

export function createQueryClient(): QueryClient {
  // 401 из любого запроса — сессия истекла: сбрасываем текущего пользователя, guard отправит на /login.
  const on401 = (err: unknown) => {
    if (err instanceof ApiRequestError && err.status === 401) client.setQueryData(meKey, null);
  };
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({ onError: on401 }),
    mutationCache: new MutationCache({ onError: on401 }),
    defaultOptions: {
      queries: {
        retry: (count, err) =>
          !(err instanceof ApiRequestError && err.status > 0 && err.status < 500) && count < 1,
        refetchOnWindowFocus: false,
        staleTime: 10_000,
      },
    },
  });
  return client;
}
