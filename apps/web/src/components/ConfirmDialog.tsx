import { Dialog, Text } from '@gravity-ui/uikit';
import type { ReactNode } from 'react';

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  text: ReactNode;
  confirmText: string;
  danger?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog(p: ConfirmDialogProps) {
  return (
    <Dialog open={p.open} onClose={p.onCancel} aria-labelledby="cr-confirm-title" size="s">
      <Dialog.Header caption={p.title} id="cr-confirm-title" />
      <Dialog.Body>
        <Text as="div">{p.text}</Text>
      </Dialog.Body>
      <Dialog.Footer
        onClickButtonApply={p.onConfirm}
        onClickButtonCancel={p.onCancel}
        textButtonApply={p.confirmText}
        textButtonCancel="Отмена"
        loading={p.loading}
        propsButtonApply={{ view: p.danger ? 'outlined-danger' : 'action' }}
      />
    </Dialog>
  );
}
