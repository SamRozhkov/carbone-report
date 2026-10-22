import { Button, Card, Text, TextInput } from '@gravity-ui/uikit';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import { api } from '../api/endpoints';
import { meKey, useMe } from '../api/session';
import { ErrorAlert } from '../components/ErrorAlert';
import { LocaleSwitcher } from '../i18n/LocaleSwitcher';

/** Разрешаем только внутренние пути: «/…», но не «//host» и не «/\host». */
export function safeNext(next: string | null): string {
  if (!next || !next.startsWith('/')) return '/reports';
  try {
    const base = window.location.origin;
    const u = new URL(next, base);
    if (u.origin !== base) return '/reports';
    const out = u.pathname + u.search + u.hash;
    if (out.startsWith('//') || out.startsWith('/\\')) return '/reports';
    return out;
  } catch {
    return '/reports';
  }
}

export function LoginPage() {
  const me = useMe();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const { t } = useTranslation();

  const mutation = useMutation({
    mutationFn: () => api.login({ login, password }),
    onSuccess: (user) => {
      // Кэш предыдущего пользователя (админские списки) не должен пережить смену сессии.
      queryClient.clear();
      queryClient.setQueryData(meKey, user);
      navigate(next, { replace: true });
    },
  });

  if (me.data) return <Navigate to={next} replace />;

  return (
    <div className="cr-centered">
      <Card view="outlined" style={{ width: 360, padding: 32 }}>
        <form
          className="cr-form"
          onSubmit={(e) => {
            e.preventDefault();
            mutation.mutate();
          }}
        >
          <Text variant="header-1" as="h1">
            Carbone Reports
          </Text>
          <label className="cr-field">
            <Text variant="subheader-1">{t('common:login.login')}</Text>
            <TextInput
              value={login}
              onUpdate={setLogin}
              autoFocus
              controlProps={{ 'aria-label': t('common:login.login') }}
            />
          </label>
          <label className="cr-field">
            <Text variant="subheader-1">{t('common:login.password')}</Text>
            <TextInput
              type="password"
              value={password}
              onUpdate={setPassword}
              controlProps={{ 'aria-label': t('common:login.password') }}
            />
          </label>
          <ErrorAlert error={mutation.error} />
          <Button
            view="action"
            size="l"
            type="submit"
            loading={mutation.isPending}
            disabled={!login || !password}
          >
            {t('common:login.submit')}
          </Button>
        </form>
        <div style={{ marginTop: 16 }}>
          <LocaleSwitcher persist="local" width="max" />
        </div>
      </Card>
    </div>
  );
}
