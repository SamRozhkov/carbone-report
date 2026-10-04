import { Alert } from '@gravity-ui/uikit';
import { ErrorAlert } from './ErrorAlert';

/** Общая ошибка: всё, что не относится к показанным полям, должно оставаться видимым. */
export function GeneralError({
  error,
  errors,
  shown,
}: {
  error: unknown;
  errors: Record<string, string>;
  shown: string[];
}) {
  if (!error) return null;
  const keys = Object.keys(errors);
  if (keys.length === 0) return <ErrorAlert error={error} />;
  const unmatched = keys.filter((k) => !shown.includes(k));
  if (unmatched.length === 0) return null;
  return (
    <Alert
      theme="danger"
      message={unmatched.map((k) => (k === '_' ? errors[k] : `${k}: ${errors[k]}`)).join('; ')}
    />
  );
}
