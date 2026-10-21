import type { TemplateAdminDetails, TemplateEditors } from '@carbone-reports/shared';
import { TrashBin } from '@gravity-ui/icons';
import { Button, Icon, Loader, Select, Text, useToaster } from '@gravity-ui/uikit';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { api } from '../../../api/endpoints';
import { usePermissions } from '../../../app/permissions';
import { ErrorAlert } from '../../../components/ErrorAlert';
import { Field } from '../../../components/Field';
import { sameIds } from '../../../lib/ids';
import { templateKey } from './editorState';

/**
 * Владелец и выданные редакторы шаблона (§43.5): виден владельцу и `admin`
 * (`canManageEditors`); смена владельца — только `admin`.
 */
export function EditorsBlock({ template }: { template: TemplateAdminDetails }) {
  const id = template.id;
  const queryClient = useQueryClient();
  const { add } = useToaster();
  const { isAdmin } = usePermissions();
  const headingId = useId();
  const editorsKey = ['template-editors', id];
  const editors = useQuery({ queryKey: editorsKey, queryFn: () => api.templates.editors(id) });
  // Логины всех активных (владельцем может быть и администратор), выбор — только из редакторов.
  const people = useQuery({
    queryKey: ['users', 'directory'],
    queryFn: () => api.users.directory(),
  });
  const candidates = useQuery({
    queryKey: ['users', 'directory', 'editor'],
    queryFn: () => api.users.directory('editor'),
  });

  const [baseline, setBaseline] = useState<TemplateEditors | undefined>(undefined);
  const [userIds, setUserIds] = useState<string[]>([]);
  const [newOwner, setNewOwner] = useState<string | undefined>(undefined);
  const dirty = !!baseline && !sameIds(userIds, baseline.userIds);
  const reseed = (e: TemplateEditors) => {
    setBaseline(e);
    setUserIds(e.userIds);
  };
  // Новые данные с сервера подхватываем, только если нет несохранённых правок.
  if (editors.data && editors.data !== baseline && !dirty) reseed(editors.data);

  const applyEditors = (e: TemplateEditors) => {
    queryClient.setQueryData(editorsKey, e);
    reseed(e);
  };
  const save = useMutation({
    mutationFn: () => api.templates.setEditors(id, userIds),
    onSuccess: (e) => {
      applyEditors(e);
      add({ name: `tpl-editors-${Date.now()}`, title: 'Редакторы сохранены', theme: 'success' });
    },
  });
  const changeOwner = useMutation({
    mutationFn: (userId: string) => api.templates.setOwner(id, userId),
    onSuccess: async (e) => {
      applyEditors(e);
      setNewOwner(undefined);
      add({ name: `tpl-owner-${Date.now()}`, title: 'Владелец изменён', theme: 'success' });
      // Права в шаблоне (canDelete, canManageEditors) зависят от владельца — перечитываем.
      await queryClient.invalidateQueries({ queryKey: templateKey(id) });
    },
  });

  const logins = new Map((people.data ?? []).map((u) => [u.id, u.login]));
  // Заблокированных нет в справочнике.
  const loginOf = (uid: string) => logins.get(uid) ?? (people.data ? '(заблокирован)' : '…');
  const ownerId = baseline?.ownerId ?? null;
  const addOptions = (candidates.data ?? [])
    .filter((u) => u.id !== ownerId && !userIds.includes(u.id))
    .map((u) => ({ value: u.id, content: u.login }));
  const ownerOptions = (candidates.data ?? [])
    .filter((u) => u.id !== ownerId)
    .map((u) => ({ value: u.id, content: u.login }));

  return (
    <section aria-labelledby={headingId} className="cr-form" style={{ marginTop: 16 }}>
      <Text variant="subheader-2" id={headingId}>
        Редакторы
      </Text>
      <ErrorAlert error={editors.error} title="Не удалось загрузить редакторов" />
      {people.error && (
        <ErrorAlert error={people.error} title="Не удалось загрузить пользователей" />
      )}
      {candidates.error && (
        <ErrorAlert error={candidates.error} title="Не удалось загрузить пользователей" />
      )}
      {editors.isPending && <Loader size="s" />}
      {baseline && (
        <>
          <Field label="Владелец" group>
            <Text color={ownerId ? undefined : 'secondary'}>
              {ownerId ? loginOf(ownerId) : 'не назначен'}
            </Text>
          </Field>
          {isAdmin && (
            <Field label="Смена владельца" group>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <Select
                  aria-label="Новый владелец"
                  value={newOwner ? [newOwner] : []}
                  onUpdate={([v]) => {
                    changeOwner.reset();
                    setNewOwner(v);
                  }}
                  options={ownerOptions}
                  loading={candidates.isPending}
                  filterable
                  placeholder="выберите редактора"
                  width="max"
                />
                <Button
                  onClick={() => newOwner && changeOwner.mutate(newOwner)}
                  loading={changeOwner.isPending}
                  disabled={!newOwner}
                >
                  Сменить владельца
                </Button>
              </div>
            </Field>
          )}
          <ErrorAlert error={changeOwner.error} />
          <Field label="Выданные редакторы" group>
            {userIds.length === 0 ? (
              <Text color="secondary">редакторов нет</Text>
            ) : (
              <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
                {userIds.map((uid) => (
                  <li key={uid} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <Text>{loginOf(uid)}</Text>
                    <Button
                      view="flat"
                      size="s"
                      aria-label={`Убрать ${loginOf(uid)}`}
                      title="Убрать"
                      onClick={() => {
                        save.reset();
                        setUserIds((ids) => ids.filter((x) => x !== uid));
                      }}
                    >
                      <Icon data={TrashBin} />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </Field>
          <Field label="Добавить редактора">
            <Select
              aria-label="Добавить редактора"
              value={[]}
              onUpdate={([v]) => {
                if (!v) return;
                save.reset();
                setUserIds((ids) => (ids.includes(v) ? ids : [...ids, v]));
              }}
              options={addOptions}
              loading={candidates.isPending}
              filterable
              placeholder="выберите пользователя с ролью «Редактор»"
              width="max"
            />
          </Field>
          <ErrorAlert error={save.error} />
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Button
              view="action"
              onClick={() => save.mutate()}
              loading={save.isPending}
              disabled={!dirty}
            >
              Сохранить редакторов
            </Button>
            {dirty && (
              <>
                <Text color="warning">Есть несохранённые изменения</Text>
                <Button
                  view="flat"
                  aria-label="Отменить изменения редакторов"
                  onClick={() => {
                    save.reset();
                    reseed(editors.data ?? baseline);
                  }}
                >
                  Отменить
                </Button>
              </>
            )}
          </div>
        </>
      )}
    </section>
  );
}
