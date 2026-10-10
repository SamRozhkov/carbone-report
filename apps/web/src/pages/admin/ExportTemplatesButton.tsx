import { ArrowDownToSquare } from '@gravity-ui/icons';
import { Button, Icon, useToaster } from '@gravity-ui/uikit';
import { useMutation } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { api } from '../../api/endpoints';
import { errorMessage } from '../../api/errors';
import { triggerDownload } from '../../lib/download';

/** «Выгрузить»: архив выбранных шаблонов (§33.3); ошибка сервера (одинаковые названия, размер) — в уведомлении. */
export function ExportTemplatesButton({
  ids,
  view = 'outlined',
  children = 'Выгрузить',
}: {
  ids: string[];
  view?: 'outlined' | 'flat';
  children?: ReactNode;
}) {
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
        title: 'Не удалось выгрузить',
        content: errorMessage(e),
        theme: 'danger',
      }),
  });
  return (
    <Button
      view={view}
      disabled={ids.length === 0}
      loading={exp.isPending}
      onClick={() => exp.mutate()}
    >
      <Icon data={ArrowDownToSquare} />
      {children}
    </Button>
  );
}
