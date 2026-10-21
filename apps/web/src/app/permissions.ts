import type { Role } from '@carbone-reports/shared';
import { useMe } from '../api/session';

/** Права интерфейса по роли (§43.2, §43.5): меню, маршруты и кнопки проверяют флаги, а не роль. */
export interface Permissions {
  isAdmin: boolean;
  /** Конструктор шаблонов: `admin`, `editor`. */
  canAuthor: boolean;
  /** Группы, категории и доступ к отчётам: `admin`, `access_manager`. */
  canManageAccess: boolean;
}

export function permissionsOf(role: Role | undefined): Permissions {
  return {
    isAdmin: role === 'admin',
    canAuthor: role === 'admin' || role === 'editor',
    canManageAccess: role === 'admin' || role === 'access_manager',
  };
}

export function usePermissions(): Permissions {
  return permissionsOf(useMe().data?.role);
}
