import type { Card, SheetLayout, SheetSnapshot } from '@carbone-reports/shared';
import { Text } from '@gravity-ui/uikit';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { DocumentActionButton } from './DocumentActionButton';
import { overlaps } from './sheetOverlap';
import { useConfirm } from './useConfirm';
import { useSheetAction } from './useDocumentAction';

type SheetCard = Extract<Card, { type: 'sheet' }>;

/** Строк раскладки в превью карточки. */
const PREVIEW_ROWS = 10;

/** На листе есть содержимое; усечённый снимок — заведомо непуст. */
const sheetFilled = (s: SheetSnapshot) => s.truncated || s.cells.some((c) => c.text !== '');

/** Сетка текстов первых строк раскладки. */
function previewRows(layout: SheetLayout): string[][] {
  const rows = Array.from({ length: Math.min(PREVIEW_ROWS, layout.rows) }, () =>
    Array.from({ length: layout.cols }, () => ''),
  );
  for (const c of layout.cells) {
    const row = rows[c.row];
    if (row && c.col < row.length) row[c.col] = c.value;
  }
  return rows;
}

/**
 * «Вставить в таблицу» (§53.3): фрагмент или таблица — раскладкой от активной ячейки. Активная
 * ячейка и занятость — по свежему снимку; непустые ячейки под раскладкой — после подтверждения.
 */
export function SheetInsertButton({
  templateId,
  layout,
}: {
  templateId: string;
  layout: () => SheetLayout;
}) {
  const { t } = useTranslation();
  const sheet = useSheetAction(templateId);
  const confirm = useConfirm(sheet.mounted);
  // Кнопка без возможности не видна (DocumentActionButton), диалог остаётся смонтированным:
  // возможность могла пропасть, пока вопрос открыт, — ответ всё равно нужен действию.
  const insert = () =>
    sheet.run(async (a) => {
      const l = layout();
      const s = await a.snapshot();
      if (overlaps(s, s.active, l) && !(await confirm.ask())) return false;
      await a.insertCells(s.active, l);
    });
  return (
    <>
      <DocumentActionButton
        state={sheet}
        label={t('common:assistant.cardInsertSheet')}
        onClick={insert}
      />
      <ConfirmDialog
        open={confirm.open}
        title={t('common:assistant.cardInsertSheet')}
        text={t('common:assistant.cardOverwriteCellsConfirm')}
        confirmText={t('common:assistant.cardOverwriteCellsApply')}
        danger
        modalClassName="cr-assistant-dialog"
        onCancel={() => confirm.answer(false)}
        onConfirm={() => confirm.answer(true)}
      />
    </>
  );
}

/** Карточка листа целиком (§53.3): превью сеткой и «Сформировать лист». */
export function SheetCardView({ card }: { card: SheetCard }) {
  const { t } = useTranslation();
  const sheet = useSheetAction(card.templateId);
  const confirm = useConfirm(sheet.mounted);
  const rows = previewRows(card.layout);

  const form = () =>
    sheet.run(async (a) => {
      // Пустота — по снимку в момент применения: лист мог измениться после ответа модели.
      if (sheetFilled(await a.snapshot()) && !(await confirm.ask())) return false;
      await a.applyLayout(card.layout);
    });

  return (
    <div className="cr-assistant__card">
      <div className="cr-assistant__table-wrap">
        <table className="cr-assistant__table cr-assistant__sheet">
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {r.map((c, j) => (
                  <td key={j}>{c}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {card.explanation && <Text color="secondary">{card.explanation}</Text>}
      {sheet.visible && (
        <div className="cr-assistant__actions">
          <DocumentActionButton
            state={sheet}
            label={t('common:assistant.cardFormSheet')}
            onClick={form}
          />
        </div>
      )}
      <ConfirmDialog
        open={confirm.open}
        title={t('common:assistant.cardFormSheet')}
        text={t('common:assistant.cardReplaceSheetConfirm')}
        confirmText={t('common:assistant.cardReplaceDocumentApply')}
        danger
        modalClassName="cr-assistant-dialog"
        onCancel={() => confirm.answer(false)}
        onConfirm={() => confirm.answer(true)}
      />
    </div>
  );
}
