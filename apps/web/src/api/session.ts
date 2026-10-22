import type { Features, Role } from '@carbone-reports/shared';
import type { Locale } from '@carbone-reports/shared/i18n';
import { useQuery } from '@tanstack/react-query';
import { ApiRequestError } from './client';
import { api } from './endpoints';

export interface SessionUser {
  id: string;
  login: string;
  role: Role;
  /** Включённые функции (§26.3); нет поля — функции выключены. */
  features?: Features;
  /** Выбранный язык интерфейса (§44.1); null — не выбирал. */
  locale?: Locale | null;
}

export const meKey = ['me'] as const;

export function useMe() {
  return useQuery({
    queryKey: meKey,
    queryFn: async (): Promise<SessionUser | null> => {
      try {
        return await api.me.get();
      } catch (e) {
        if (e instanceof ApiRequestError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
  });
}
