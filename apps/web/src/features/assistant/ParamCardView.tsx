import { Button, Text, useToaster } from '@gravity-ui/uikit';
import { useTranslation } from 'react-i18next';
import { useAssistantBridge, type ApplyCard } from './bridge';
import { useCopy } from './useCopy';

type ParamCard = Extract<ApplyCard, { type: 'param' }>;

/** Карточка параметра (§51.5): описание, применение в черновик вкладки «Параметры». */
export function ParamCardView({ card }: { card: ParamCard }) {
  const { t } = useTranslation();
  const bridge = useAssistantBridge();
  const { add } = useToaster();
  const copy = useCopy();
  const p = card.param;
  const sameTemplate = bridge.editor?.templateId === card.templateId;
  const exists = bridge.draft()?.params.some((d) => d.name === p.name) ?? false;

  const apply = () => {
    if (bridge.apply(card) === 'queued') {
      add({
        name: 'assistant-queued',
        theme: 'info',
        title: t('common:assistant.cardQueuedParams'),
      });
    }
  };

  return (
    <div className="cr-assistant__card">
      <Text variant="subheader-1">{p.name}</Text>
      <Text>
        {p.label} · {t(`editor:params.type_${p.type}`)}
        {p.required ? ` · ${t('editor:params.required')}` : ''}
        {p.multiple ? ` · ${t('editor:params.multiple')}` : ''}
      </Text>
      {p.options && p.options.length > 0 && (
        <Text color="secondary">{p.options.map((o) => o.label).join(', ')}</Text>
      )}
      {p.sql && <pre className="cr-assistant__code">{p.sql}</pre>}
      <div className="cr-assistant__actions">
        <Button view="action" disabled={!sameTemplate} onClick={apply}>
          {exists
            ? t('common:assistant.cardReplaceParam', { name: p.name })
            : t('common:assistant.cardAddParam')}
        </Button>
        <Button view="outlined" onClick={() => copy(JSON.stringify(p, null, 2))}>
          {t('common:assistant.cardCopy')}
        </Button>
      </div>
      {!sameTemplate && <Text color="secondary">{t('common:assistant.cardOpenTemplate')}</Text>}
    </div>
  );
}
