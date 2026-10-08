import type { BackupDto } from '@carbone-reports/shared';
import { Alert, Dialog, TextInput } from '@gravity-ui/uikit';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/endpoints';
import { ErrorAlert } from '../../components/ErrorAlert';
import { Field } from '../../components/Field';

const CONFIRM_LABEL = 'Введите имя бэкапа для подтверждения';

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
      <Dialog.Header caption="Восстановление из бэкапа" id="cr-restore-title" />
      <Dialog.Body>
        <div className="cr-form">
          <Alert
            theme="warning"
            title="База данных и файлы заменяются"
            message={
              <>
                Данные приложения будут заменены состоянием из бэкапа <b>{name}</b>. Перед
                восстановлением будет сделан бэкап текущего состояния (pre-restore-…) — к нему можно
                вернуться. Пользователей, в том числе вас, может разлогинить: понадобится войти
                заново.
              </>
            }
          />
          <Field label={CONFIRM_LABEL} hint={name}>
            <TextInput
              value={typed}
              onUpdate={setTyped}
              placeholder={name}
              autoComplete="off"
              controlProps={{ 'aria-label': CONFIRM_LABEL }}
            />
          </Field>
          <ErrorAlert error={restore.error} />
        </div>
      </Dialog.Body>
      <Dialog.Footer
        onClickButtonApply={() => restore.mutate(name)}
        onClickButtonCancel={close}
        textButtonApply="Восстановить"
        textButtonCancel="Отмена"
        loading={restore.isPending}
        propsButtonApply={{ view: 'outlined-danger', disabled: name === '' || typed !== name }}
      />
    </Dialog>
  );
}
