import { Loader } from '@gravity-ui/uikit';
import { Navigate, Outlet, useLocation } from 'react-router';
import { useMe } from '../api/session';
import { ErrorAlert } from '../components/ErrorAlert';

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

export function RequireAdmin() {
  const me = useMe();
  if (me.data?.role !== 'admin') return <Navigate to="/reports" replace />;
  return <Outlet />;
}
