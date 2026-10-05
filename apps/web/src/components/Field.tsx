import { Text } from '@gravity-ui/uikit';
import { useId, type ReactNode } from 'react';

export function Field({
  label,
  error,
  hint,
  group,
  children,
}: {
  label: string;
  error?: string;
  hint?: string;
  /** Для составных контролов (радио-группа): div role=group вместо label, чтобы клик по подписи не активировал первый контрол. */
  group?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  const Root = group ? 'div' : 'label';
  return (
    <Root className="cr-field" {...(group ? { role: 'group', 'aria-labelledby': id } : {})}>
      <Text variant="subheader-1" id={group ? id : undefined}>
        {label}
      </Text>
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
    </Root>
  );
}
