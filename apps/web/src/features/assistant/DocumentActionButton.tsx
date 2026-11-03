import { Button, Text } from '@gravity-ui/uikit';
import { useTranslation } from 'react-i18next';
import type { DocumentActionState } from './useDocumentAction';

/** Кнопка формирования в документе (§52.4) и подсказка, если документ открыт только для просмотра. */
export function DocumentActionButton({
  state,
  label,
  disabled,
  onClick,
}: {
  state: DocumentActionState;
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  const { t } = useTranslation();
  if (!state.visible) return null;
  return (
    <>
      <Button
        view="action"
        disabled={state.readOnly || state.busy || disabled}
        loading={state.busy}
        onClick={onClick}
      >
        {label}
      </Button>
      {state.readOnly && (
        <Text color="secondary">{t('common:assistant.cardDocumentReadOnly')}</Text>
      )}
    </>
  );
}
