import { ArrowDownToSquare } from '@gravity-ui/icons';
import { Button, Icon, useToaster } from '@gravity-ui/uikit';
import { useMutation } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { MAX_TRANSFER_TEMPLATES } from '@carbone-reports/shared/template-transfer';
import { api } from '../../api/endpoints';
import { errorMessage } from '../../api/errors';
import { triggerDownload } from '../../lib/download';

/** «Выгрузить»: архив выбранных шаблонов (§33.3); ошибка сервера (одинаковые названия, размер) — в уведомлении. */
export function ExportTemplatesButton({
  ids,
  view = 'outlined',
  children,
}: {
  ids: string[];
  view?: 'outlined' | 'flat';
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const { add } = useToaster();
  const exp = useMutation({
    mutationFn: async () => {
      const { blob, filename } = await api.templates.export(ids);
      const url = URL.createObjectURL(blob);
      triggerDownload(url, filename ?? 'templates.crt.zip');
      // Ссылка нужна браузеру, пока он забирает файл; потом память освобождается.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    },
    onError: (e) =>
      add({
        name: `tpl-export-${Date.now()}`,
        title: t('templates:export.failed'),
        content: errorMessage(e),
        theme: 'danger',
      }),
  });
  return (
    <Button
      view={view}
      disabled={ids.length === 0}
      loading={exp.isPending}
      onClick={() => {
        if (ids.length > MAX_TRANSFER_TEMPLATES) {
          add({
            name: `tpl-export-limit-${Date.now()}`,
            title: t('templates:export.tooMany'),
            content: t('templates:export.tooManyText', {
              max: MAX_TRANSFER_TEMPLATES,
              selected: ids.length,
            }),
            theme: 'warning',
          });
          return;
        }
        exp.mutate();
      }}
    >
      <Icon data={ArrowDownToSquare} />
      {children ?? t('templates:export.button')}
    </Button>
  );
}
