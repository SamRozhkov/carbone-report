import { Text } from '@gravity-ui/uikit';
import type { ReactNode } from 'react';

export function Field({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error?: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="cr-field">
      <Text variant="subheader-1">{label}</Text>
      {children}
      {hint && !error && (
        <Text color="secondary" variant="caption-2" data-testid="field-hint">
          {hint}
        </Text>
      )}
      {error && (
        <Text color="danger" variant="body-short" data-testid="field-error">
          {error}
        </Text>
      )}
    </label>
  );
}
