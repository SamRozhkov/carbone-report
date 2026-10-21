import { Loader } from '@gravity-ui/uikit';
import { Navigate, Outlet, useLocation } from 'react-router';
import { useMe } from '../api/session';
import { ErrorAlert } from '../components/ErrorAlert';
import type { Permissions } from './permissions';
import { usePermissions } from './permissions';

export function FullPageLoader() {
  return (
    <div className="cr-centered">
      <Loader size="l" />
    </div>
  );
}

export function RequireUser() {
  const me = useMe();
  const location = useLocation();
  if (me.isPending) return <FullPageLoader />;
  if (me.isError) {
    return (
      <div className="cr-centered">
        <ErrorAlert error={me.error} title="Не удалось проверить вход" />
      </div>
    );
  }
  if (!me.data) {
    const next = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?next=${next}`} replace />;
  }
  return <Outlet />;
}

/** Раздел по праву (§43.5): без права — на `/reports`. */
export function RequireRole({ allow }: { allow: (p: Permissions) => boolean }) {
  const permissions = usePermissions();
  if (!allow(permissions)) return <Navigate to="/reports" replace />;
  return <Outlet />;
}

/** Индекс `/admin`: первый раздел, доступный роли. */
export function AdminIndex() {
  const { canAuthor, canManageAccess } = usePermissions();
  const to = canAuthor ? '/admin/templates' : canManageAccess ? '/admin/groups' : '/reports';
  return <Navigate to={to} replace />;
}
