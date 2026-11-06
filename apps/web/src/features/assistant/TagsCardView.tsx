import type { Card } from '@carbone-reports/shared';
import { Button, Text } from '@gravity-ui/uikit';
import { useTranslation } from 'react-i18next';
import { DocumentActionButton } from './DocumentActionButton';
import { textLayout } from './sheetAdapter';
import { SheetInsertButton } from './SheetCardView';
import { useCopy } from './useCopy';
import { useDocumentAction } from './useDocumentAction';

/** Карточка фрагмента документа с тегами (§51.5): копируется и вставляется в документ вручную,
 *  а при доступном формировании — кнопкой в позицию курсора (§52.4) или в активную ячейку листа
 *  (§53.3). */
export function TagsCardView({ card }: { card: Extract<Card, { type: 'tags' }> }) {
  const { t } = useTranslation();
  const copy = useCopy();
  const doc = useDocumentAction(card.templateId);
  return (
    <div className="cr-assistant__card">
      <pre className="cr-assistant__code">{card.text}</pre>
      {card.explanation && <Text color="secondary">{card.explanation}</Text>}
      <div className="cr-assistant__actions">
        <DocumentActionButton
          state={doc}
          label={t('common:assistant.cardInsert')}
          onClick={() => doc.run((a) => a.insertTags(card.text))}
        />
        {/* В листе xlsx/ods — строки фрагмента по ячейкам вниз от активной (§53.3). */}
        <SheetInsertButton templateId={card.templateId} layout={() => textLayout(card.text)} />
        <Button view="outlined" onClick={() => copy(card.text)}>
          {t('common:assistant.cardCopy')}
        </Button>
        <Text color="secondary">{t('common:assistant.cardPasteHint')}</Text>
      </div>
    </div>
  );
}
