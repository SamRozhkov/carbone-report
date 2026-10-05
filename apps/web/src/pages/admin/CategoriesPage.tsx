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
        title: 'Не удалось удалить',
        content: errorMessage(e),
        theme: 'danger',
      });
    },
  });

  const columns: TableColumnConfig<CategoryDto>[] = [
    { id: 'sortOrder', name: 'Порядок', align: 'end', template: (c) => c.sortOrder },
    { id: 'name', name: 'Название', template: (c) => c.name },
    {
      id: 'public',
      name: 'Доступно всем',
      template: (c) => (c.public ? <Label theme="success">да</Label> : '—'),
    },
    {
      id: 'groups',
      name: 'Группы',
      template: (c) =>
        c.groupIds
          .map((id) => groupName.get(id))
          .filter(Boolean)
          .join(', ') || '—',
    },
    { id: 'templates', name: 'Шаблонов', align: 'end', template: (c) => c.templateCount },
    {
      id: 'actions',
      name: '',
      align: 'end',
      template: (c) => (
        <div style={{ display: 'flex', gap: 4, justifyContent: 'flex-end' }}>
          <Button
            view="flat"
            size="s"
            aria-label="Изменить"
            title="Изменить"
            onClick={() => setDialog({ category: c })}
          >
            <Icon data={Pencil} />
          </Button>
          <Button
            view="flat-danger"
            size="s"
            aria-label="Удалить"
            title="Удалить"
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
        title="Категории"
        actions={
          <Button view="action" onClick={() => setDialog({ category: null })}>
            <Icon data={Plus} />
            Добавить категорию
          </Button>
        }
      />
      <ErrorAlert error={list.error} />
      {groups.error && <ErrorAlert error={groups.error} title="Не удалось загрузить группы" />}
      {list.isPending ? (
        <Loader />
      ) : (
        <Table
          data={list.data ?? []}
          columns={columns}
          getRowDescriptor={(c) => ({ id: c.id })}
          emptyMessage="Категорий пока нет"
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
        title="Удалить категорию?"
        text={`Категория «${(deleting ?? lastDeleted)?.name ?? ''}» будет удалена. Шаблоны категории останутся без категории, доступ, выданный через неё, пропадёт.`}
        confirmText="Удалить"
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
      <Dialog.Header caption={category ? 'Категория' : 'Новая категория'} id="cr-category-dialog" />
      <Dialog.Body>
        <div className="cr-form">
          <Field label="Название" error={nameError}>
            <TextInput
              value={name}
              onUpdate={(v) => {
                save.reset();
                setName(v);
              }}
              validationState={nameError ? 'invalid' : undefined}
              controlProps={{ 'aria-label': 'Название' }}
            />
          </Field>
          <Field label="Порядок" error={errors.sortOrder} hint="меньше — выше в каталоге отчётов">
            <NumberInput
              value={sortOrder}
              onUpdate={setSortOrder}
              min={-1_000_000}
              max={1_000_000}
              allowDecimal={false}
              validationState={errors.sortOrder ? 'invalid' : undefined}
              controlProps={{ 'aria-label': 'Порядок' }}
            />
          </Field>
          <Field label="Видимость" error={errors.public} group>
            <Checkbox checked={isPublic} onUpdate={setIsPublic} content="Доступно всем" />
          </Field>
          <Field label="Группы" hint="группы, которым видны все шаблоны категории" group>
            <Select
              aria-label="Группы"
              value={groupIds}
              onUpdate={setGroupIds}
              options={(groups.data ?? []).map((g) => ({ value: g.id, content: g.name }))}
              multiple
              filterable
              hasClear
              loading={groups.isPending}
              placeholder="нет групп"
              width="max"
            />
          </Field>
          {groups.error && <ErrorAlert error={groups.error} title="Не удалось загрузить группы" />}
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
        textButtonApply={saved ? 'Сохранить' : 'Создать'}
        textButtonCancel="Отмена"
        loading={save.isPending}
        propsButtonApply={{ disabled: !name.trim() }}
      />
    </Dialog>
  );
}
