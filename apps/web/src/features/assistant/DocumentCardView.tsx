import type { Card, DocSnapshot } from '@carbone-reports/shared';
import { Text } from '@gravity-ui/uikit';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { DocumentActionButton } from './DocumentActionButton';
import { TablePreview } from './TableCardView';
import { useDocumentAction } from './useDocumentAction';

type DocumentCard = Extract<Card, { type: 'document' }>;

const HEADING_VARIANT = { 1: 'subheader-3', 2: 'subheader-2', 3: 'subheader-1' } as const;

/** В теле документа есть текст: колонтитулы не в счёт — replaceAll их не трогает. */
const bodyFilled = (s: DocSnapshot) =>
  s.blocks.some(
    (b) =>
      b.area === 'body' &&
      (b.type === 'p' ? b.text.trim() !== '' : b.rows.some((r) => r.some((c) => c.trim() !== ''))),
  );

/** Карточка документа целиком (§52.4): превью структуры и «Сформировать документ». */
export function DocumentCardView({ card }: { card: DocumentCard }) {
  const { t } = useTranslation();
  const doc = useDocumentAction(card.templateId);
  // Ожидающее подтверждение: резолвер промиса, которого ждёт действие с документом.
  const [confirm, setConfirm] = useState<((ok: boolean) => void) | null>(null);
  const confirmRef = useRef(confirm);
  confirmRef.current = confirm;
  // Карточка снята с открытым вопросом — ответ «нет», действие не повисает.
  useEffect(() => () => confirmRef.current?.(false), []);
  const hasTables = card.blocks.some((b) => b.type === 'table');

  const ask = () =>
    new Promise<boolean>((resolve) => {
      // Карточка уже снята (отложенное применение) — спросить негде, ничего не меняем.
      if (!doc.mounted()) return resolve(false);
      setConfirm(() => resolve);
    });
  const answer = (ok: boolean) => {
    confirm?.(ok);
    setConfirm(null);
  };

  const form = () =>
    doc.run(async (a) => {
      // Пустота — по снимку в момент применения: документ мог измениться после ответа модели.
      if (bodyFilled(await a.snapshot()) && !(await ask())) return false;
      await a.replaceAll(card.blocks);
    });

  return (
    <div className="cr-assistant__card">
      <div className="cr-assistant__doc">
        {card.blocks.map((b, i) => {
          switch (b.type) {
            case 'heading':
              return (
                <Text key={i} as="div" variant={HEADING_VARIANT[b.level]}>
                  {b.text}
                </Text>
              );
            case 'p':
              return (
                <div key={i} className="cr-assistant__doc-p">
                  {b.text}
                </div>
              );
            case 'table':
              return <TablePreview key={i} rows={b.rows} />;
          }
        })}
      </div>
      {hasTables && (
        <Text variant="caption-2" color="secondary">
          {t('common:assistant.cardTableServiceRow')}
        </Text>
      )}
      {card.explanation && <Text color="secondary">{card.explanation}</Text>}
      {doc.visible && (
        <div className="cr-assistant__actions">
          <DocumentActionButton
            state={doc}
            label={t('common:assistant.cardFormDocument')}
            onClick={form}
          />
        </div>
      )}
      <ConfirmDialog
        open={confirm !== null}
        title={t('common:assistant.cardFormDocument')}
        text={t('common:assistant.cardReplaceDocumentConfirm')}
        confirmText={t('common:assistant.cardReplaceDocumentApply')}
        danger
        modalClassName="cr-assistant-dialog"
        onCancel={() => answer(false)}
        onConfirm={() => answer(true)}
      />
    </div>
  );
}
