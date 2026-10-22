import type { BackupDto } from '@carbone-reports/shared';
import { Alert, Dialog, TextInput } from '@gravity-ui/uikit';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { api } from '../../api/endpoints';
import { ErrorAlert } from '../../components/ErrorAlert';
import { Field } from '../../components/Field';

/** Подтверждение восстановления точным именем бэкапа (§26.5). */
export function RestoreDialog({
  backup,
  onClose,
  onStarted,
}: {
  backup: BackupDto | null;
  onClose: () => void;
  onStarted: () => void;
}) {
  const { t } = useTranslation();
  const confirmLabel = t('admin:restore.confirmLabel');
  const [typed, setTyped] = useState('');
  const name = backup?.name ?? '';
  const restore = useMutation({
    mutationFn: (n: string) => api.backups.restore(n),
    onSuccess: () => {
      onStarted();
      close();
    },
  });

  function close() {
    setTyped('');
    restore.reset();
    onClose();
  }

  return (
    <Dialog open={backup !== null} onClose={close} aria-labelledby="cr-restore-title" size="m">
      <Dialog.Header caption={t('admin:restore.title')} id="cr-restore-title" />
      <Dialog.Body>
        <div className="cr-form">
          <Alert
            theme="warning"
            title={t('admin:restore.warningTitle')}
            message={
              <Trans i18nKey="admin:restore.warning" values={{ name }} components={{ b: <b /> }} />
            }
          />
          <Field label={confirmLabel} hint={name}>
            <TextInput
              value={typed}
              onUpdate={setTyped}
              placeholder={name}
              autoComplete="off"
              controlProps={{ 'aria-label': confirmLabel }}
            />
          </Field>
          <ErrorAlert error={restore.error} />
        </div>
      </Dialog.Body>
      <Dialog.Footer
        onClickButtonApply={() => restore.mutate(name)}
        onClickButtonCancel={close}
        textButtonApply={t('admin:backups.restore')}
        textButtonCancel={t('common:action.cancel')}
        loading={restore.isPending}
        propsButtonApply={{ view: 'outlined-danger', disabled: name === '' || typed !== name }}
      />
    </Dialog>
  );
}
