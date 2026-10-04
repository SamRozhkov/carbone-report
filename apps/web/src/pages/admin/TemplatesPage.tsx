import type { TemplateSummary } from '@carbone-reports/shared';
import { ArrowDownToLine, Copy, Pencil, Plus, TrashBin } from '@gravity-ui/icons';
import type { TableColumnConfig } from '@gravity-ui/uikit';
import { Button, Icon, Label, Loader, Table, Text, useToaster } from '@gravity-ui/uikit';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, templateDownloadUrl } from '../../api/endpoints';
import { errorMessage } from '../../api/errors';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { ErrorAlert } from '../../components/ErrorAlert';
import { PageHeader } from '../../components/PageHeader';
import { formatDateTime } from '../../lib/format';
import { CreateTemplateDialog } from './CreateTemplateDialog';

export function TemplatesPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { add } = useToaster();
  const list = useQuery({ queryKey: ['templates'], queryFn: api.templates.list });
  const [createOpen, setCreateOpen] = useState(false);
  const [deleting, setDeleting] = useState<TemplateSummary | null>(null);
  const [lastDeleted, setLastDeleted] = useState<TemplateSummary | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['templates'] });
  const fail = (e: unknown) =>
    add({
      name: `tpl-error-${Date.now()}`,
      title: 'Ошибка',
      content: errorMessage(e),
      theme: 'danger',
    });

  const duplicate = useMutation({
    mutationFn: (t: TemplateSummary) => api.templates.duplicate(t.id),
    onSuccess: async (copy) => {
      await refresh();
      add({
        name: `tpl-dup-${Date.now()}`,
        title: `Создана копия «${copy.name}»`,
        theme: 'success',
      });
    },
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (t: TemplateSummary) => api.templates.remove(t.id),
    onSuccess: async (_, t) => {
      queryClient.removeQueries({ queryKey: ['template', t.id] });
      queryClient.removeQueries({ queryKey: ['template-admin', t.id] });
      await refresh();
      setDeleting(null);
    },
    onError: fail,
  });

  const columns: TableColumnConfig<TemplateSummary>[] = [
    {
      id: 'name',
      name: 'Название',
      template: (t) => (
        <div>
          <Link to={`/admin/templates/${t.id}`}>{t.name}</Link>
          {t.description && (
            <Text as="div" variant="caption-2" color="secondary">
              {t.description}
            </Text>
          )}
        </div>
      ),
    },
    {
      id: 'ext',
      name: 'Тип',
      template: (t) => <Label size="xs">{t.fileExt.toUpperCase()}</Label>,
      width: 80,
    },
    { id: 'updatedAt', name: 'Изменён', template: (t) => formatDateTime(t.updatedAt), width: 150 },
    {
      id: 'actions',
      name: '',
      align: 'end',
      template: (t) => (
        <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
          <Button
            view="flat"
            size="s"
            aria-label="Открыть"
            title="Открыть"
            onClick={() => navigate(`/admin/templates/${t.id}`)}
          >
            <Icon data={Pencil} />
          </Button>
          <Button
            view="flat"
            size="s"
            aria-label="Дублировать"
            title="Дублировать"
            loading={duplicate.isPending && duplicate.variables?.id === t.id}
            onClick={() => duplicate.mutate(t)}
          >
            <Icon data={Copy} />
          </Button>
          <Button
            view="flat"
            size="s"
            aria-label="Скачать"
            title="Скачать"
            href={templateDownloadUrl(t.id)}
          >
            <Icon data={ArrowDownToLine} />
          </Button>
          <Button
            view="flat-danger"
            size="s"
            aria-label="Удалить"
            title="Удалить"
            onClick={() => {
              setLastDeleted(t);
              setDeleting(t);
            }}
          >
            <Icon data={TrashBin} />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Шаблоны"
        actions={
          <Button view="action" onClick={() => setCreateOpen(true)}>
            <Icon data={Plus} />
            Создать шаблон
          </Button>
        }
      />
      <ErrorAlert error={list.error} />
      {list.isPending ? (
        <Loader />
      ) : (
        <Table
          data={list.data ?? []}
          columns={columns}
          getRowDescriptor={(t) => ({ id: t.id })}
          emptyMessage="Шаблонов пока нет"
          width="max"
        />
      )}
      {createOpen && <CreateTemplateDialog open onClose={() => setCreateOpen(false)} />}
      <ConfirmDialog
        open={!!deleting}
        title="Удалить шаблон?"
        text={`Шаблон «${lastDeleted?.name ?? ''}» будет удалён вместе с запросами и параметрами. История запусков сохранится.`}
        confirmText="Удалить"
        danger
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
        onCancel={() => setDeleting(null)}
      />
    </>
  );
}
