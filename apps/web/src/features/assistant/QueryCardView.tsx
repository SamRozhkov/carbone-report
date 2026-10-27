import { Alert, Button, Text, useToaster } from '@gravity-ui/uikit';
import { useTranslation } from 'react-i18next';
import { useAssistantBridge, type ApplyCard } from './bridge';
import { useCopy } from './useCopy';

type QueryCard = Extract<ApplyCard, { type: 'query' }>;

/** Карточка запроса (§51.5): SQL, результат проверки, применение в черновик вкладки «Данные». */
export function QueryCardView({ card }: { card: QueryCard }) {
  const { t } = useTranslation();
  const bridge = useAssistantBridge();
  const { add } = useToaster();
  const copy = useCopy();
  const sameTemplate = bridge.editor?.templateId === card.templateId;
  const exists = bridge.draft()?.queries.some((q) => q.key === card.key) ?? false;
  const mode = t(
    card.mode === 'list' ? 'common:assistant.cardModeList' : 'common:assistant.cardModeSingle',
  );

  const apply = () => {
    if (bridge.apply(card) === 'queued') {
      add({
        name: 'assistant-queued',
        theme: 'info',
        title: t('common:assistant.cardQueuedData'),
      });
    }
  };

  return (
    <div className="cr-assistant__card">
      <Text variant="subheader-1">
        {card.key} · {mode}
      </Text>
      <pre className="cr-assistant__code">{card.sql}</pre>
      {card.check.ok ? (
        <Text color="secondary">
          {t('common:assistant.cardCheckOk', {
            columns: card.check.columns.map((c) => `${c.name} (${c.type})`).join(', '),
          })}
        </Text>
      ) : (
        <Alert
          theme="danger"
          message={t('common:assistant.cardCheckFailed', { error: card.check.error })}
        />
      )}
      <div className="cr-assistant__actions">
        <Button view="action" disabled={!sameTemplate} onClick={apply}>
          {exists
            ? t('common:assistant.cardReplaceQuery', { key: card.key })
            : t('common:assistant.cardAddQuery')}
        </Button>
        <Button view="outlined" onClick={() => copy(card.sql)}>
          {t('common:assistant.cardCopy')}
        </Button>
      </div>
      {!sameTemplate && (
        <Text color="secondary">
          {t('common:assistant.cardOpenTemplate', { name: card.templateName })}
        </Text>
      )}
    </div>
  );
}
