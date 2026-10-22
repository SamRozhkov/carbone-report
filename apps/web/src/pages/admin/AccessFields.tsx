import type { TemplateAccess } from '@carbone-reports/shared';
import { Alert, Checkbox, Select, useToaster } from '@gravity-ui/uikit';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/endpoints';
import { ErrorAlert } from '../../components/ErrorAlert';
import { Field } from '../../components/Field';
import { sameIds } from '../../lib/ids';

const NO_CATEGORY = '__none__';

/** Поля формы доступа, которые показывают своими элементами (остальные ошибки — общим блоком). */
export const ACCESS_FIELDS = ['categoryId', 'public'];

export const sameAccess = (a: TemplateAccess, b: TemplateAccess) =>
  a.public === b.public && a.categoryId === b.categoryId && sameIds(a.groupIds, b.groupIds);

/**
 * Кто видит шаблон: «доступно всем», категория и группы (правило — в access.ts на сервере).
 * Общие поля вкладки «Настройки» конструктора и диалога страницы «Доступ к отчётам».
 */
export function AccessFields({
  value,
  onChange,
  errors,
  dirty,
}: {
  value: TemplateAccess;
  onChange: (patch: Partial<TemplateAccess>) => void;
  errors: Record<string, string>;
  dirty: boolean;
}) {
  const { t } = useTranslation();
  const categories = useQuery({ queryKey: ['categories'], queryFn: api.categories.list });
  const groups = useQuery({ queryKey: ['groups'], queryFn: api.groups.list });

  const category = value.categoryId
    ? categories.data?.find((c) => c.id === value.categoryId)
    : undefined;
  // Без данных о выбранной категории вывод сделать нельзя — предупреждение не показываем.
  const categoryKnown = !value.categoryId || !!category;
  const adminOnly =
    categoryKnown &&
    !value.public &&
    value.groupIds.length === 0 &&
    !(category && (category.public || category.groupIds.length > 0));

  return (
    <>
      {categories.error && (
        <ErrorAlert error={categories.error} title={t('admin:loadFailed.categories')} />
      )}
      {groups.error && <ErrorAlert error={groups.error} title={t('admin:loadFailed.groups')} />}
      <Field label={t('admin:field.category')} error={errors.categoryId}>
        <Select
          aria-label={t('admin:field.category')}
          value={[value.categoryId ?? NO_CATEGORY]}
          onUpdate={([v]) => onChange({ categoryId: !v || v === NO_CATEGORY ? null : v })}
          options={[
            { value: NO_CATEGORY, content: t('templates:access.noCategory') },
            ...(categories.data ?? []).map((c) => ({ value: c.id, content: c.name })),
          ]}
          loading={categories.isPending}
          filterable
          width="max"
        />
      </Field>
      <Field label={t('admin:field.visibility')} error={errors.public} group>
        <Checkbox
          checked={value.public}
          onUpdate={(v) => onChange({ public: v })}
          content={t('admin:field.public')}
        />
      </Field>
      <Field label={t('admin:field.groups')} hint={t('templates:access.groupsHint')} group>
        <Select
          aria-label={t('admin:field.groups')}
          value={value.groupIds}
          onUpdate={(v) => onChange({ groupIds: v })}
          options={(groups.data ?? []).map((g) => ({ value: g.id, content: g.name }))}
          multiple
          filterable
          hasClear
          loading={groups.isPending}
          placeholder={t('admin:noGroups')}
          width="max"
        />
      </Field>
      {adminOnly && (
        <Alert
          theme="warning"
          message={
            dirty ? t('templates:access.adminOnlyAfterSave') : t('templates:access.adminOnlyNow')
          }
        />
      )}
    </>
  );
}

/** Сохранение доступа шаблона: кэш доступа, списки шаблонов (и «Доступ к отчётам») и категорий. */
export function useSaveTemplateAccess(
  templateId: string,
  onSaved: (saved: TemplateAccess) => void,
) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { add } = useToaster();
  return useMutation({
    mutationFn: (body: TemplateAccess) => api.templates.access(templateId, body),
    onSuccess: async (saved) => {
      queryClient.setQueryData(['template-access', templateId], saved);
      onSaved(saved);
      add({
        name: `tpl-access-${Date.now()}`,
        title: t('templates:access.saved'),
        theme: 'success',
      });
      await Promise.all(
        [['templates'], ['categories']].map((queryKey) =>
          queryClient.invalidateQueries({ queryKey }),
        ),
      );
    },
  });
}
