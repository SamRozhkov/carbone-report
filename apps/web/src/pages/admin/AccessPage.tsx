import type { AccessTemplateRow, TemplateAccess } from '@carbone-reports/shared';
import { Pencil } from '@gravity-ui/icons';
import type { TableColumnConfig } from '@gravity-ui/uikit';
import { Button, Icon, Loader, Table, TextInput } from '@gravity-ui/uikit';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/endpoints';
import { ErrorAlert } from '../../components/ErrorAlert';
import { PageHeader } from '../../components/PageHeader';
import { TemplateAccessDialog } from './TemplateAccessDialog';

/** Под ключом ['templates', …]: любое изменение шаблонов обновляет и эту таблицу. */
const ROWS_KEY = ['templates', 'access'];

/** «Доступ к отчётам» (§43.5): кто видит каждый шаблон; перехода в конструктор нет. */
export function AccessPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const list = useQuery({ queryKey: ROWS_KEY, queryFn: api.access.templates });
  const categories = useQuery({ queryKey: ['categories'], queryFn: api.categories.list });
  const groups = useQuery({ queryKey: ['groups'], queryFn: api.groups.list });
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<AccessTemplateRow | null>(null);

  const categoryName = new Map((categories.data ?? []).map((c) => [c.id, c.name]));
  const groupName = new Map((groups.data ?? []).map((g) => [g.id, g.name]));
  const needle = search.trim().toLowerCase();
  const rows = (list.data ?? []).filter((r) => r.name.toLowerCase().includes(needle));

  const onSaved = (id: string, saved: TemplateAccess) =>
    queryClient.setQueryData<AccessTemplateRow[]>(ROWS_KEY, (old) =>
      old?.map((r) => (r.id === id ? { ...r, ...saved } : r)),
    );

  const columns: TableColumnConfig<AccessTemplateRow>[] = [
    { id: 'name', name: t('admin:field.name'), template: (r) => r.name },
    {
      id: 'category',
      name: t('admin:field.category'),
      template: (r) => (r.categoryId ? (categoryName.get(r.categoryId) ?? '…') : '—'),
    },
    {
      id: 'groups',
      name: t('admin:field.groups'),
      template: (r) =>
        r.groupIds
          .map((gid) => groupName.get(gid))
          .filter(Boolean)
          .join(', ') || '—',
    },
    {
      id: 'public',
      name: t('admin:access.public'),
      template: (r) => (r.public ? t('admin:yes') : t('admin:no')),
    },
    {
      id: 'actions',
      name: '',
      align: 'end',
      template: (r) => (
        <Button
          view="flat"
          size="s"
          aria-label={t('admin:access.editAria', { name: r.name })}
          title={t('admin:access.editTitle')}
          onClick={(e) => {
            e.stopPropagation();
            setEditing(r);
          }}
        >
          <Icon data={Pencil} />
        </Button>
      ),
    },
  ];

  return (
    <>
      <PageHeader title={t('common:nav.access')} />
      <ErrorAlert error={list.error} />
      {categories.error && (
        <ErrorAlert error={categories.error} title={t('admin:loadFailed.categories')} />
      )}
      {groups.error && <ErrorAlert error={groups.error} title={t('admin:loadFailed.groups')} />}
      <div style={{ maxWidth: 400, marginBottom: 12 }}>
        <TextInput
          value={search}
          onUpdate={setSearch}
          placeholder={t('admin:access.search')}
          hasClear
          controlProps={{ 'aria-label': t('admin:access.search') }}
        />
      </div>
      {list.isPending ? (
        <Loader />
      ) : (
        <Table
          data={rows}
          columns={columns}
          getRowDescriptor={(r) => ({ id: r.id })}
          onRowClick={(r) => setEditing(r)}
          emptyMessage={needle ? t('admin:access.nothingFound') : t('admin:access.empty')}
          width="max"
        />
      )}
      {editing && (
        <TemplateAccessDialog
          key={editing.id}
          templateId={editing.id}
          name={editing.name}
          access={{
            public: editing.public,
            categoryId: editing.categoryId,
            groupIds: editing.groupIds,
          }}
          onSaved={(saved) => onSaved(editing.id, saved)}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}
