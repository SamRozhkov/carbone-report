import { Alert } from '@gravity-ui/uikit';
import { errorMessage } from '../api/errors';

export function ErrorAlert({ error, title }: { error: unknown; title?: string }) {
  if (!error) return null;
  return <Alert theme="danger" title={title} message={errorMessage(error)} />;
}
