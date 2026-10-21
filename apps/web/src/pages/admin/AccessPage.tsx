import type { AccessTemplateRow, TemplateAccess } from '@carbone-reports/shared';
import { Pencil } from '@gravity-ui/icons';
import type { TableColumnConfig } from '@gravity-ui/uikit';
import { Button, Icon, Loader, Table, TextInput } from '@gravity-ui/uikit';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/endpoints';
import { ErrorAlert } from '../../components/ErrorAlert';
import { PageHeader } from '../../components/PageHeader';
import { TemplateAccessDialog } from './TemplateAccessDialog';

/** Под ключом ['templates', …]: любое изменение шаблонов обновляет и эту таблицу. */
const ROWS_KEY = ['templates', 'access'];

/** «Доступ к отчётам» (§43.5): кто видит каждый шаблон; перехода в конструктор нет. */
export function AccessPage() {
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
    { id: 'name', name: 'Название', template: (r) => r.name },
    {
      id: 'category',
      name: 'Категория',
      template: (r) => (r.categoryId ? (categoryName.get(r.categoryId) ?? '…') : '—'),
    },
    {
      id: 'groups',
      name: 'Группы',
      template: (r) =>
        r.groupIds
          .map((gid) => groupName.get(gid))
          .filter(Boolean)
          .join(', ') || '—',
    },
    { id: 'public', name: 'Доступен всем', template: (r) => (r.public ? 'да' : 'нет') },
    {
      id: 'actions',
      name: '',
      align: 'end',
      template: (r) => (
        <Button
          view="flat"
          size="s"
          aria-label={`Доступ: ${r.name}`}
          title="Изменить доступ"
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
      <PageHeader title="Доступ к отчётам" />
      <ErrorAlert error={list.error} />
      {categories.error && (
        <ErrorAlert error={categories.error} title="Не удалось загрузить категории" />
      )}
      {groups.error && <ErrorAlert error={groups.error} title="Не удалось загрузить группы" />}
      <div style={{ maxWidth: 400, marginBottom: 12 }}>
        <TextInput
          value={search}
          onUpdate={setSearch}
          placeholder="Поиск по названию"
          hasClear
          controlProps={{ 'aria-label': 'Поиск по названию' }}
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
          emptyMessage={needle ? 'Ничего не найдено' : 'Шаблонов пока нет'}
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
