import type { TemplateAccess } from '@carbone-reports/shared';
import { Dialog } from '@gravity-ui/uikit';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fieldErrors } from '../../api/errors';
import { GeneralError } from '../../components/GeneralError';
import { ACCESS_FIELDS, AccessFields, sameAccess, useSaveTemplateAccess } from './AccessFields';

/** Доступ к шаблону со страницы «Доступ к отчётам»: те же поля, что на вкладке «Настройки». */
export function TemplateAccessDialog({
  templateId,
  name,
  access,
  onSaved,
  onClose,
}: {
  templateId: string;
  name: string;
  access: TemplateAccess;
  onSaved: (saved: TemplateAccess) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [form, setForm] = useState<TemplateAccess>(access);
  const dirty = !sameAccess(form, access);
  const save = useSaveTemplateAccess(templateId, (saved) => {
    onSaved(saved);
    onClose();
  });
  const errors = fieldErrors(save.error);
  const set = (patch: Partial<TemplateAccess>) => {
    save.reset();
    setForm((f) => ({ ...f, ...patch }));
  };

  return (
    <Dialog open onClose={onClose} aria-labelledby="cr-template-access">
      <Dialog.Header
        caption={t('templates:access.dialogTitle', { name })}
        id="cr-template-access"
      />
      <Dialog.Body>
        <div className="cr-form">
          <AccessFields value={form} onChange={set} errors={errors} dirty={dirty} />
          <GeneralError error={save.error} errors={errors} shown={ACCESS_FIELDS} />
        </div>
      </Dialog.Body>
      <Dialog.Footer
        onClickButtonApply={() => save.mutate(form)}
        onClickButtonCancel={onClose}
        textButtonApply={t('common:action.save')}
        textButtonCancel={t('common:action.cancel')}
        loading={save.isPending}
        propsButtonApply={{ disabled: !dirty }}
      />
    </Dialog>
  );
}
