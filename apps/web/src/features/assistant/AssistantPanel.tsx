import { Xmark } from '@gravity-ui/icons';
import { Alert, Button, Icon, Text, TextArea } from '@gravity-ui/uikit';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAssistantBridge } from './bridge';
import { ParamCardView } from './ParamCardView';
import { QueryCardView } from './QueryCardView';
import { RunCardView } from './RunCardView';
import { TableCardView } from './TableCardView';
import { TagsCardView } from './TagsCardView';
import type { AssistantChat } from './useAssistantChat';
import './assistant.css';

/** Панель ассистента справа (§50.5): немодальная, страница под ней остаётся рабочей. */
export function AssistantPanel({ chat }: { chat: AssistantChat }) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const inEditor = useAssistantBridge().editor !== null;
  const feed = useRef<HTMLDivElement>(null);

  // Новая реплика — лента прокручивается вниз.
  useEffect(() => {
    const el = feed.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat.messages.length, chat.pending]);

  const submit = (value: string) => {
    if (!value.trim() || chat.pending) return;
    chat.send(value);
    setText('');
  };

  const title = t('common:assistant.title');
  return (
    <aside className="cr-assistant" aria-label={title}>
      <div className="cr-assistant__header">
        <Text variant="subheader-2">{title}</Text>
        <div className="cr-assistant__header-actions">
          <Button view="flat" size="s" onClick={chat.reset}>
            {t('common:assistant.newChat')}
          </Button>
          <Button
            view="flat"
            size="s"
            onClick={() => chat.setOpen(false)}
            extraProps={{ 'aria-label': t('common:assistant.close') }}
          >
            <Icon data={Xmark} />
          </Button>
        </div>
      </div>
      <div className="cr-assistant__feed" ref={feed}>
        {chat.messages.length === 0 && (
          <div className="cr-assistant__empty">
            <Text color="secondary">{t('common:assistant.empty')}</Text>
            {inEditor ? (
              // В редакторе шаблона — подсказки автору (§51.5).
              <>
                {(['suggestQuery', 'suggestTables', 'suggestTags'] as const).map((k) => (
                  <Button
                    key={k}
                    view="outlined"
                    onClick={() => submit(t(`common:assistant.${k}`))}
                  >
                    {t(`common:assistant.${k}`)}
                  </Button>
                ))}
              </>
            ) : (
              <>
                {chat.reportId && (
                  <Button view="outlined" onClick={() => submit(t('common:assistant.suggestThis'))}>
                    {t('common:assistant.suggestThis')}
                  </Button>
                )}
                <Button view="outlined" onClick={() => submit(t('common:assistant.suggestList'))}>
                  {t('common:assistant.suggestList')}
                </Button>
              </>
            )}
          </div>
        )}
        {chat.messages.map((m, i) => (
          <div key={i} className="cr-assistant__turn">
            {/* Ответ может быть пустым, если есть карточки: пустой пузырь не рисуется. */}
            {m.content && (
              <div className={`cr-assistant__msg cr-assistant__msg_${m.role}`}>{m.content}</div>
            )}
            {m.role === 'assistant' &&
              m.cards?.map((c, j) => {
                switch (c.type) {
                  case 'run':
                    return <RunCardView key={j} card={c} />;
                  case 'query':
                    return <QueryCardView key={j} card={c} />;
                  case 'param':
                    return <ParamCardView key={j} card={c} />;
                  case 'tags':
                    return <TagsCardView key={j} card={c} />;
                  case 'table':
                    return <TableCardView key={j} card={c} />;
                }
              })}
          </div>
        ))}
        {chat.pending && <Text color="secondary">{t('common:assistant.thinking')}</Text>}
        {chat.error && <Alert theme="danger" message={chat.error} />}
      </div>
      <div className="cr-assistant__input">
        <TextArea
          value={text}
          onUpdate={setText}
          minRows={2}
          maxRows={8}
          disabled={chat.pending}
          placeholder={t('common:assistant.placeholder')}
          controlProps={{ 'aria-label': t('common:assistant.placeholder'), maxLength: 4000 }}
          onKeyDown={(e) => {
            // Enter — отправка, Shift+Enter — перенос строки.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit(text);
            }
          }}
        />
        {chat.pending ? (
          <Button view="outlined" onClick={chat.stop}>
            {t('common:assistant.stop')}
          </Button>
        ) : (
          <Button view="action" disabled={!text.trim()} onClick={() => submit(text)}>
            {t('common:assistant.send')}
          </Button>
        )}
      </div>
    </aside>
  );
}
