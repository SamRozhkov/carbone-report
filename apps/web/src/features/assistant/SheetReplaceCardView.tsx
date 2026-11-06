import type { Card } from '@carbone-reports/shared';
import { Checkbox, Text } from '@gravity-ui/uikit';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DocumentActionButton } from './DocumentActionButton';
import { useSheetAction } from './useDocumentAction';

type SheetReplaceCard = Extract<Card, { type: 'sheetReplace' }>;

interface Marks {
  items: number[];
  table: boolean;
}

/** Карточка замен значений на теги в листе (§53.3): «было → станет» с адресом и галочками,
 *  таблица отдельным пунктом. */
export function SheetReplaceCardView({ card }: { card: SheetReplaceCard }) {
  const { t } = useTranslation();
  const sheet = useSheetAction(card.templateId);
  const [items, setItems] = useState(() => card.items.map(() => true));
  const [table, setTable] = useState(card.table !== null);
  const [notFound, setNotFound] = useState<Marks>({ items: [], table: false });
  const count = items.filter(Boolean).length + (card.table && table ? 1 : 0);

  const apply = () => {
    // Адаптер возвращает «не найдено» индексами в переданном массиве выбранных пунктов.
    const pi = items.flatMap((on, i) => (on ? [i] : []));
    const tb = table ? card.table : null;
    sheet.run(async (a) => {
      const r = await a.replace(
        pi.map((i) => card.items[i]!),
        tb,
      );
      if (!sheet.mounted()) return;
      // Пометки — по индексам карточки; прежние снимаются, видно итог последнего применения.
      setNotFound({ items: r.notFound.items.map((k) => pi[k]!), table: r.notFound.table });
    });
  };

  const missing = (
    <Text color="danger" className="cr-assistant__missing">
      {t('common:assistant.cardNotFound')}
    </Text>
  );

  return (
    <div className="cr-assistant__card">
      <ul className="cr-assistant__replace">
        {card.items.map((it, i) => (
          <li key={`i${i}`}>
            <Checkbox
              checked={items[i]}
              onUpdate={(on) => setItems((f) => f.map((v, j) => (j === i ? on : v)))}
            >
              <span className="cr-assistant__replace-ref">{it.ref}</span>
              <span className="cr-assistant__replace-text">{`${it.find} → ${it.tag}`}</span>
            </Checkbox>
            {it.note && <Text color="secondary">{it.note}</Text>}
            {notFound.items.includes(i) && missing}
          </li>
        ))}
        {card.table && (
          <li key="table">
            <Checkbox checked={table} onUpdate={setTable}>
              <span className="cr-assistant__replace-text">
                {t('common:assistant.cardSheetTable', {
                  first: card.table.firstDataRow + 1,
                  last: card.table.lastDataRow + 1,
                  key: card.table.key,
                })}
              </span>
            </Checkbox>
            {notFound.table && missing}
          </li>
        )}
      </ul>
      {card.explanation && <Text color="secondary">{card.explanation}</Text>}
      {sheet.visible && (
        <div className="cr-assistant__actions">
          <DocumentActionButton
            state={sheet}
            label={t('common:assistant.cardReplaceSelected', { count })}
            disabled={count === 0}
            onClick={apply}
          />
        </div>
      )}
    </div>
  );
}
