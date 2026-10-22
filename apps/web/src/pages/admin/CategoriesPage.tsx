import type { CategoryDto, CategoryPatch } from '@carbone-reports/shared';
import { Pencil, Plus, TrashBin } from '@gravity-ui/icons';
import type { TableColumnConfig } from '@gravity-ui/uikit';
import {
  Button,
  Checkbox,
  Dialog,
  Icon,
  Label,
  Loader,
  NumberInput,
  Select,
  Table,
  TextInput,
  useToaster,
} from '@gravity-ui/uikit';
import type { QueryClient } from '@tanstack/react-query';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/endpoints';
import { conflictMessage, errorMessage, fieldErrors } from '../../api/errors';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { ErrorAlert } from '../../components/ErrorAlert';
import { Field } from '../../components/Field';
import { GeneralError } from '../../components/GeneralError';
import { PageHeader } from '../../components/PageHeader';
import { sameIds } from '../../lib/ids';

/** Категория видна в каталоге и в настройках шаблонов (предупреждение о доступе). */
const invalidateCategories = (queryClient: QueryClient) =>
  Promise.all(
    [['categories'], ['templates']].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
  );

export function CategoriesPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { add } = useToaster();
  const list = useQuery({ queryKey: ['categories'], queryFn: api.categories.list });
  const groups = useQuery({ queryKey: ['groups'], queryFn: api.groups.list });
  const [dialog, setDialog] = useState<{ category: CategoryDto | null } | null>(null);
  const [deleting, setDeleting] = useState<CategoryDto | null>(null);
  const [lastDeleted, setLastDeleted] = useState<CategoryDto | null>(null);
  const groupName = new Map((groups.data ?? []).map((g) => [g.id, g.name]));

  const remove = useMutation({
    mutationFn: (c: CategoryDto) => api.categories.remove(c.id),
    onSuccess: async () => {
      await invalidateCategories(queryClient);
      void queryClient.invalidateQueries({ queryKey: ['template-access'] });
      setDeleting(null);
    },
    onError: (e) => {
      setDeleting(null);
      add({
        name: `category-delete-${Date.now()}`,
        title: t('admin:deleteFailed'),
        content: errorMessage(e),
        theme: 'danger',
      });
    },
  });

  const columns: TableColumnConfig<CategoryDto>[] = [
    {
      id: 'sortOrder',
      name: t('admin:categories.order'),
      align: 'end',
      template: (c) => c.sortOrder,
    },
    { id: 'name', name: t('admin:field.name'), template: (c) => c.name },
    {
      id: 'public',
      name: t('admin:field.public'),
      template: (c) => (c.public ? <Label theme="success">{t('admin:yes')}</Label> : '—'),
    },
    {
      id: 'groups',
      name: t('admin:field.groups'),
      template: (c) =>
        c.groupIds
          .map((id) => groupName.get(id))
          .filter(Boolean)
          .join(', ') || '—',
    },
    {
      id: 'templates',
      name: t('admin:categories.templates'),
      align: 'end',
      template: (c) => c.templateCount,
    },
    {
      id: 'actions',
      name: '',
      align: 'end',
      template: (c) => (
        <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
          <Button
            view="flat"
            size="s"
            aria-label={t('common:action.edit')}
            title={t('common:action.edit')}
            onClick={() => setDialog({ category: c })}
          >
            <Icon data={Pencil} />
          </Button>
          <Button
            view="flat-danger"
            size="s"
            aria-label={t('common:action.delete')}
            title={t('common:action.delete')}
            onClick={() => {
              setLastDeleted(c);
              setDeleting(c);
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
        title={t('common:nav.categories')}
        actions={
          <Button view="action" onClick={() => setDialog({ category: null })}>
            <Icon data={Plus} />
            {t('admin:categories.add')}
          </Button>
        }
      />
      <ErrorAlert error={list.error} />
      {groups.error && <ErrorAlert error={groups.error} title={t('admin:loadFailed.groups')} />}
      {list.isPending ? (
        <Loader />
      ) : (
        <Table
          data={list.data ?? []}
          columns={columns}
          getRowDescriptor={(c) => ({ id: c.id })}
          emptyMessage={t('admin:categories.empty')}
          width="max"
        />
      )}
      {dialog && (
        <CategoryDialog
          key={dialog.category?.id ?? 'new'}
          category={dialog.category}
          onClose={() => setDialog(null)}
        />
      )}
      <ConfirmDialog
        open={!!deleting}
        title={t('admin:categories.deleteTitle')}
        text={t('admin:categories.deleteText', { name: (deleting ?? lastDeleted)?.name ?? '' })}
        confirmText={t('common:action.delete')}
        danger
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting)}
        onCancel={() => setDeleting(null)}
      />
    </>
  );
}

function CategoryDialog({
  category,
  onClose,
}: {
  category: CategoryDto | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const groups = useQuery({ queryKey: ['groups'], queryFn: api.groups.list });
  // Сохранённое состояние: после POST и неудачного PUT groups повтор не создаёт дубль.
  const [saved, setSaved] = useState<CategoryDto | null>(category);
  const [name, setName] = useState(category?.name ?? '');
  const [sortOrder, setSortOrder] = useState<number | null>(category?.sortOrder ?? 0);
  const [isPublic, setIsPublic] = useState(category?.public ?? false);
  const [groupIds, setGroupIds] = useState<string[]>(category?.groupIds ?? []);
  const order = sortOrder ?? 0;

  const save = useMutation({
    mutationFn: async () => {
      let current = saved;
      if (!current) {
        current = await api.categories.create({ name, sortOrder: order, public: isPublic });
        setSaved(current);
      } else {
        const body: CategoryPatch = {
          ...(name !== current.name ? { name } : {}),
          ...(order !== current.sortOrder ? { sortOrder: order } : {}),
          ...(isPublic !== current.public ? { public: isPublic } : {}),
        };
        if (Object.keys(body).length) {
          current = await api.categories.update(current.id, body);
          setSaved(current);
        }
      }
      if (!sameIds(groupIds, current.groupIds)) {
        current = await api.categories.setGroups(current.id, groupIds);
        setSaved(current);
      }
      return current;
    },
    onSettled: () => invalidateCategories(queryClient),
    onSuccess: () => onClose(),
  });
  const errors = fieldErrors(save.error);
  const conflict = conflictMessage(save.error);
  const nameError = errors.name ?? conflict;

  return (
    <Dialog open onClose={onClose} aria-labelledby="cr-category-dialog">
      <Dialog.Header
        caption={category ? t('admin:categories.dialogEdit') : t('admin:categories.dialogNew')}
        id="cr-category-dialog"
      />
      <Dialog.Body>
        <div className="cr-form">
          <Field label={t('admin:field.name')} error={nameError}>
            <TextInput
              value={name}
              onUpdate={(v) => {
                save.reset();
                setName(v);
              }}
              validationState={nameError ? 'invalid' : undefined}
              controlProps={{ 'aria-label': t('admin:field.name') }}
            />
          </Field>
          <Field
            label={t('admin:categories.order')}
            error={errors.sortOrder}
            hint={t('admin:categories.orderHint')}
          >
            <NumberInput
              value={sortOrder}
              onUpdate={setSortOrder}
              min={-1_000_000}
              max={1_000_000}
              allowDecimal={false}
              validationState={errors.sortOrder ? 'invalid' : undefined}
              controlProps={{ 'aria-label': t('admin:categories.order') }}
            />
          </Field>
          <Field label={t('admin:field.visibility')} error={errors.public} group>
            <Checkbox checked={isPublic} onUpdate={setIsPublic} content={t('admin:field.public')} />
          </Field>
          <Field label={t('admin:field.groups')} hint={t('admin:categories.groupsHint')} group>
            <Select
              aria-label={t('admin:field.groups')}
              value={groupIds}
              onUpdate={setGroupIds}
              options={(groups.data ?? []).map((g) => ({ value: g.id, content: g.name }))}
              multiple
              filterable
              hasClear
              loading={groups.isPending}
              placeholder={t('admin:noGroups')}
              width="max"
            />
          </Field>
          {groups.error && <ErrorAlert error={groups.error} title={t('admin:loadFailed.groups')} />}
          <GeneralError
            error={conflict ? null : save.error}
            errors={errors}
            shown={['name', 'sortOrder', 'public']}
          />
        </div>
      </Dialog.Body>
      <Dialog.Footer
        onClickButtonApply={() => save.mutate()}
        onClickButtonCancel={onClose}
        textButtonApply={saved ? t('common:action.save') : t('admin:create')}
        textButtonCancel={t('common:action.cancel')}
        loading={save.isPending}
        propsButtonApply={{ disabled: !name.trim() }}
      />
    </Dialog>
  );
}
