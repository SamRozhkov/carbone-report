import type { Card } from '@carbone-reports/shared';
import { Grip } from '@gravity-ui/icons';
import { Button, Icon, Text } from '@gravity-ui/uikit';
import { useTranslation } from 'react-i18next';
import { useCopy } from './useCopy';

type TableCard = Extract<Card, { type: 'table' }>;

/** Текст ячейки для HTML: заголовки приходят от модели — экранируем всё значимое. */
const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!,
  );

/** HTML для буфера и перетаскивания: настоящая таблица, которую Word/OnlyOffice вставляют таблицей. */
export const tableHtml = (rows: string[][]) =>
  `<table border="1">${rows
    .map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`)
    .join('')}</table>`;

/** Текстовая замена: строки «| a | b |». */
export const tablePipe = (rows: string[][]) => rows.map((r) => `| ${r.join(' | ')} |`).join('\n');

/** Карточка таблицы для запроса-списка (§51.8): копируется или перетаскивается в документ. */
export function TableCardView({ card }: { card: TableCard }) {
  const { t } = useTranslation();
  const copy = useCopy();
  const content = () => ({ html: tableHtml(card.rows), text: tablePipe(card.rows) });
  const last = card.rows.length - 1;
  return (
    <div className="cr-assistant__card">
      <div className="cr-assistant__table-row">
        {/* Перетаскивается ручка, а не таблица: текст ячеек остаётся выделяемым. */}
        <span
          className="cr-assistant__table-drag"
          role="img"
          aria-label={t('common:assistant.cardTableDrag')}
          title={t('common:assistant.cardTableDrag')}
          draggable
          onDragStart={(e) => {
            const c = content();
            e.dataTransfer.setData('text/html', c.html);
            e.dataTransfer.setData('text/plain', c.text);
            e.dataTransfer.effectAllowed = 'copy';
          }}
        >
          <Icon data={Grip} size={14} />
        </span>
        <div className="cr-assistant__table-wrap">
          <table className="cr-assistant__table">
            <tbody>
              {card.rows.map((r, i) => (
                <tr key={i} className={i === last ? 'cr-assistant__table-service' : undefined}>
                  {r.map((c, j) => (
                    <td key={j}>{c}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <Text variant="caption-2" color="secondary">
        {t('common:assistant.cardTableServiceRow')}
      </Text>
      {card.explanation && <Text color="secondary">{card.explanation}</Text>}
      <div className="cr-assistant__actions">
        <Button view="outlined" onClick={() => copy(content())}>
          {t('common:assistant.cardCopyTable')}
        </Button>
        <Text color="secondary">{t('common:assistant.cardTableHint')}</Text>
      </div>
    </div>
  );
}
