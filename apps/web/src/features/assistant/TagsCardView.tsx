import type { Card } from '@carbone-reports/shared';
import { Button, Text } from '@gravity-ui/uikit';
import { useTranslation } from 'react-i18next';
import { useCopy } from './useCopy';

/** Карточка фрагмента документа с тегами (§51.5): копируется и вставляется в документ вручную. */
export function TagsCardView({ card }: { card: Extract<Card, { type: 'tags' }> }) {
  const { t } = useTranslation();
  const copy = useCopy();
  return (
    <div className="cr-assistant__card">
      <pre className="cr-assistant__code">{card.text}</pre>
      {card.explanation && <Text color="secondary">{card.explanation}</Text>}
      <div className="cr-assistant__actions">
        <Button view="outlined" onClick={() => copy(card.text)}>
          {t('common:assistant.cardCopy')}
        </Button>
        <Text color="secondary">{t('common:assistant.cardPasteHint')}</Text>
      </div>
    </div>
  );
}
