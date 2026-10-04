import { Text } from '@gravity-ui/uikit';
import type { ReactNode } from 'react';

export function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <label className="cr-field">
      <Text variant="subheader-1">{label}</Text>
      {children}
      {error && (
        <Text color="danger" variant="body-short">
          {error}
        </Text>
      )}
    </label>
  );
}
