import type { TemplateEditSummary } from '@carbone-reports/shared';
import { ArrowDownToLine, ArrowUpToLine, Copy, Pencil, Plus, TrashBin } from '@gravity-ui/icons';
import type { TableColumnConfig } from '@gravity-ui/uikit';
import { Button, Checkbox, Icon, Label, Loader, Table, Text, useToaster } from '@gravity-ui/uikit';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';
import { api, templateDownloadUrl } from '../../api/endpoints';
import { errorMessage } from '../../api/errors';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { ErrorAlert } from '../../components/ErrorAlert';
import { PageHeader } from '../../components/PageHeader';
import { formatDateTime } from '../../lib/format';
import { CreateTemplateDialog } from './CreateTemplateDialog';
import { ExportTemplatesButton } from './ExportTemplatesButton';
import { ImportDialog } from './ImportDialog';

export function TemplatesPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { add } = useToaster();
  // Только шаблоны, которые пользователь может править (§43.3); ключ — под общим ['templates'].
  const list = useQuery({ queryKey: ['templates', 'edit'], queryFn: api.templates.listEditable });
  const [createOpen, setCreateOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState<TemplateEditSummary | null>(null);
  const [lastDeleted, setLastDeleted] = useState<TemplateEditSummary | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['templates'] });
  const fail = (e: unknown) =>
    add({
      name: `tpl-error-${Date.now()}`,
      title: t('common:status.error'),
      content: errorMessage(e),
      theme: 'danger',
    });

  const duplicate = useMutation({
    mutationFn: (tpl: TemplateEditSummary) => api.templates.duplicate(tpl.id),
    onSuccess: async (copy) => {
      await refresh();
      add({
        name: `tpl-dup-${Date.now()}`,
        title: t('templates:list.duplicated', { name: copy.name }),
        theme: 'success',
      });
    },
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: (tpl: TemplateEditSummary) => api.templates.remove(tpl.id),
    onSuccess: async (_, tpl) => {
      queryClient.removeQueries({ queryKey: ['template', tpl.id] });
      queryClient.removeQueries({ queryKey: ['template-admin', tpl.id] });
      await refresh();
      setDeleting(null);
    },
    onError: fail,
  });

  const all = list.data ?? [];
  // Выбор переживает обновление списка: исчезнувшие (удалённые) шаблоны отбрасываются.
  const chosen = all.filter((tpl) => selected.has(tpl.id)).map((tpl) => tpl.id);
  const toggle = (id: string, on: boolean) =>
    setSelected((s) => {
      const n = new Set(s);
      if (on) n.add(id);
      else n.delete(id);
      return n;
    });

  const columns: TableColumnConfig<TemplateEditSummary>[] = [
    {
      id: 'select',
      width: 40,
      name: () => (
        <Checkbox
          controlProps={{ 'aria-label': t('templates:list.selectAll') }}
          checked={all.length > 0 && chosen.length === all.length}
          indeterminate={chosen.length > 0 && chosen.length < all.length}
          onUpdate={(on) => setSelected(on ? new Set(all.map((tpl) => tpl.id)) : new Set())}
        />
      ),
      template: (tpl) => (
        <Checkbox
          controlProps={{ 'aria-label': t('templates:list.select', { name: tpl.name }) }}
          checked={selected.has(tpl.id)}
          onUpdate={(on) => toggle(tpl.id, on)}
        />
      ),
    },
    {
      id: 'name',
      name: t('admin:field.name'),
      template: (tpl) => (
        <div>
          <Link to={`/admin/templates/${tpl.id}`}>{tpl.name}</Link>
          {tpl.editingBy && (
            <Label theme="warning" size="xs">
              {t('templates:list.editingBy', { login: tpl.editingBy.login })}
            </Label>
          )}
          {tpl.description && (
            <Text as="div" variant="caption-2" color="secondary">
              {tpl.description}
            </Text>
          )}
        </div>
      ),
    },
    {
      id: 'ext',
      name: t('templates:list.type'),
      template: (tpl) => <Label size="xs">{tpl.fileExt.toUpperCase()}</Label>,
      width: 80,
    },
    {
      id: 'updatedAt',
      name: t('templates:list.updatedAt'),
      template: (tpl) => formatDateTime(tpl.updatedAt),
      width: 150,
    },
    {
      id: 'actions',
      name: '',
      align: 'end',
      template: (tpl) => (
        <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
          <Button
            view="flat"
            size="s"
            aria-label={t('templates:list.open')}
            title={t('templates:list.open')}
            onClick={() => navigate(`/admin/templates/${tpl.id}`)}
          >
            <Icon data={Pencil} />
          </Button>
          <Button
            view="flat"
            size="s"
            aria-label={t('templates:list.duplicate')}
            title={t('templates:list.duplicate')}
            loading={duplicate.isPending && duplicate.variables?.id === tpl.id}
            onClick={() => duplicate.mutate(tpl)}
          >
            <Icon data={Copy} />
          </Button>
          <Button
            view="flat"
            size="s"
            aria-label={t('templates:list.download')}
            title={t('templates:list.download')}
            href={templateDownloadUrl(tpl.id)}
          >
            <Icon data={ArrowDownToLine} />
          </Button>
          {tpl.canDelete && (
            <Button
              view="flat-danger"
              size="s"
              aria-label={t('common:action.delete')}
              title={t('common:action.delete')}
              onClick={() => {
                setLastDeleted(tpl);
                setDeleting(tpl);
              }}
            >
              <Icon data={TrashBin} />
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title={t('common:nav.templates')}
        actions={
          <div style={{ display: 'flex', gap: 8 }}>
            <ExportTemplatesButton ids={chosen}>
              {chosen.length > 0
                ? t('templates:list.exportSelected', { n: chosen.length })
                : t('templates:export.button')}
            </ExportTemplatesButton>
            <Button view="outlined" onClick={() => setImportOpen(true)}>
              <Icon data={ArrowUpToLine} />
              {t('templates:list.import')}
            </Button>
            <Button view="action" onClick={() => setCreateOpen(true)}>
              <Icon data={Plus} />
              {t('templates:list.create')}
            </Button>
          </div>
        }
      />
      <ErrorAlert error={list.error} />
      {list.isPending ? (
        <Loader />
      ) : (
        <Table
          data={list.data ?? []}
          columns={columns}
          getRowDescriptor={(tpl) => ({ id: tpl.id })}
          emptyMessage={t('templates:list.empty')}
          width="max"
        />
      )}
      {createOpen && <CreateTemplateDialog open onClose={() => setCreateOpen(false)} />}
      {importOpen && <ImportDialog open onClose={() => setImportOpen(false)} />}
      <ConfirmDialog
        open={!!deleting}
        title={t('templates:list.deleteTitle')}
        text={t('templates:list.deleteText', { name: lastDeleted?.name ?? '' })}
        confirmText={t('common:action.delete')}
        danger
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
        onCancel={() => setDeleting(null)}
      />
    </>
  );
}
