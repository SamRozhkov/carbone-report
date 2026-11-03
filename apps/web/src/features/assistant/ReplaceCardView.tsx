import type { Card } from '@carbone-reports/shared';
import { Checkbox, Text } from '@gravity-ui/uikit';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DocumentActionButton } from './DocumentActionButton';
import { useDocumentAction } from './useDocumentAction';

type ReplaceCard = Extract<Card, { type: 'replace' }>;

interface Marks {
  items: number[];
  tables: number[];
}

/** Индексы выбранных пунктов: адаптер возвращает «не найдено» индексами в переданных массивах. */
const picked = (flags: boolean[]) => flags.flatMap((on, i) => (on ? [i] : []));

/** Карточка замен значений на теги (§52.4): «было → станет» с галочками, таблицы отдельными пунктами. */
export function ReplaceCardView({ card }: { card: ReplaceCard }) {
  const { t } = useTranslation();
  const doc = useDocumentAction(card.templateId);
  const [items, setItems] = useState(() => card.items.map(() => true));
  const [tables, setTables] = useState(() => card.tables.map(() => true));
  const [notFound, setNotFound] = useState<Marks>({ items: [], tables: [] });
  const count = items.filter(Boolean).length + tables.filter(Boolean).length;

  const toggle = (set: typeof setItems, i: number, on: boolean) =>
    set((flags) => flags.map((f, j) => (j === i ? on : f)));

  const apply = () => {
    const pi = picked(items);
    const pt = picked(tables);
    doc.run(async (a) => {
      const r = await a.replace(
        pi.map((i) => card.items[i]!),
        pt.map((i) => card.tables[i]!),
      );
      if (!doc.mounted()) return;
      // Пометки — по индексам карточки; прежние снимаются, видно итог последнего применения.
      setNotFound({
        items: r.notFound.items.map((k) => pi[k]!),
        tables: r.notFound.tables.map((k) => pt[k]!),
      });
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
            <Checkbox checked={items[i]} onUpdate={(on) => toggle(setItems, i, on)}>
              <span className="cr-assistant__replace-text">{`${it.find} → ${it.tag}`}</span>
              {it.count > 1 && (
                <span className="cr-assistant__replace-count">{`×${it.count}`}</span>
              )}
            </Checkbox>
            {it.note && <Text color="secondary">{it.note}</Text>}
            {notFound.items.includes(i) && missing}
          </li>
        ))}
        {card.tables.map((tb, i) => (
          <li key={`t${i}`}>
            <Checkbox checked={tables[i]} onUpdate={(on) => toggle(setTables, i, on)}>
              <span className="cr-assistant__replace-text">
                {t('common:assistant.cardReplaceTable', {
                  header: tb.fingerprint.header
                    .flat()
                    .filter((c) => c.trim() !== '')
                    .join(', '),
                  key: tb.key,
                })}
              </span>
            </Checkbox>
            {notFound.tables.includes(i) && missing}
          </li>
        ))}
      </ul>
      {card.explanation && <Text color="secondary">{card.explanation}</Text>}
      {doc.visible && (
        <div className="cr-assistant__actions">
          <DocumentActionButton
            state={doc}
            label={t('common:assistant.cardReplaceSelected', { count })}
            disabled={count === 0}
            onClick={apply}
          />
        </div>
      )}
    </div>
  );
}
