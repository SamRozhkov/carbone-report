import type { Features, Role } from '@carbone-reports/shared';
import { useQuery } from '@tanstack/react-query';
import { ApiRequestError } from './client';
import { api } from './endpoints';

export interface SessionUser {
  id: string;
  login: string;
  role: Role;
  /** Включённые функции (§26.3); нет поля — функции выключены. */
  features?: Features;
}

export const meKey = ['me'] as const;

export function useMe() {
  return useQuery({
    queryKey: meKey,
    queryFn: async (): Promise<SessionUser | null> => {
      try {
        return await api.me();
      } catch (e) {
        if (e instanceof ApiRequestError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
  });
}
