import { Text } from '@gravity-ui/uikit';
import type { ReactNode } from 'react';

export function PageHeader({ title, actions }: { title: ReactNode; actions?: ReactNode }) {
  return (
    <div className="cr-page-header">
      <Text variant="header-1" as="h1">
        {title}
      </Text>
      {actions && <div style={{ display: 'flex', gap: 8 }}>{actions}</div>}
    </div>
  );
}
