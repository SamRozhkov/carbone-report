import { Alert, Button, Dialog, Text, TextArea, TextInput } from '@gravity-ui/uikit';
import { useMutation } from '@tanstack/react-query';
import { useId, useRef, useState } from 'react';
import { api } from '../api/endpoints';
import { fieldErrors } from '../api/errors';
import { ErrorAlert } from './ErrorAlert';
import { Field } from './Field';

export function FeedbackDialog({
  open,
  onClose,
  page,
}: {
  open: boolean;
  onClose: () => void;
  page: string;
}) {
  const titleId = useId();
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [replyTo, setReplyTo] = useState('');
  const [validation, setValidation] = useState<Record<string, string>>({});
  const pathname = page.split(/[?#\r\n]/, 1)[0] ?? '/reports';
  const feedbackPage =
    pathname.startsWith('/') && !pathname.startsWith('//') ? pathname : '/reports';
  // Два клика до следующего React-рендера тоже должны дать только одно письмо.
  const sending = useRef(false);
  const send = useMutation({
    mutationFn: () =>
      api.feedback({
        subject: subject.trim(),
        message: message.trim(),
        ...(replyTo.trim() ? { replyTo: replyTo.trim() } : {}),
        page: feedbackPage.slice(0, 500),
      }),
    retry: false,
    onSettled: () => {
      sending.current = false;
    },
  });
  const errors = { ...fieldErrors(send.error), ...validation };
  const submit = () => {
    if (sending.current || send.isSuccess) return;
    const next: Record<string, string> = {};
    if (!subject.trim()) next.subject = 'Укажите тему сообщения';
    if (!message.trim()) next.message = 'Напишите сообщение';
    if (subject.trim().length > 160) next.subject = 'Не более 160 символов';
    if (message.trim().length > 5000) next.message = 'Не более 5000 символов';
    if (
      replyTo.trim() &&
      (replyTo.trim().length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(replyTo.trim()))
    ) {
      next.replyTo = 'Укажите корректный адрес электронной почты';
    }
    setValidation(next);
    if (Object.keys(next).length) return;
    sending.current = true;
    send.mutate();
  };
  const close = () => {
    if (sending.current) return;
    if (send.isSuccess) {
      setSubject('');
      setMessage('');
      setReplyTo('');
    }
    setValidation({});
    send.reset();
    onClose();
  };
  const edit = (set: (value: string) => void) => (value: string) => {
    set(value);
    setValidation({});
    send.reset();
  };

  return (
    <Dialog open={open} onClose={close} size="m" aria-labelledby={titleId}>
      <Dialog.Header caption="Обратная связь" id={titleId} />
      <Dialog.Body>
        {send.isSuccess ? (
          <Alert
            theme="success"
            title="Спасибо за обратную связь"
            message="Сообщение для внутренней технической поддержки передано почтовому серверу."
          />
        ) : (
          <form
            className="cr-form"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              submit();
            }}
          >
            <Text color="secondary">
              Расскажите о проблеме или предложите улучшение. Сообщение получит внутренняя
              техническая поддержка.
            </Text>
            <Field label="Тема" error={errors.subject}>
              <TextInput
                value={subject}
                onUpdate={edit(setSubject)}
                placeholder="О чём вы хотите сообщить?"
                autoFocus
                disabled={send.isPending}
                validationState={errors.subject ? 'invalid' : undefined}
                controlProps={{ 'aria-label': 'Тема', 'aria-required': true, maxLength: 160 }}
              />
            </Field>
            <Field
              label="Сообщение"
              error={errors.message}
              hint={`${message.length} / 5000 символов`}
            >
              <TextArea
                value={message}
                onUpdate={edit(setMessage)}
                placeholder="Опишите, что произошло и какого результата вы ожидали"
                minRows={6}
                maxRows={12}
                disabled={send.isPending}
                validationState={errors.message ? 'invalid' : undefined}
                controlProps={{ 'aria-label': 'Сообщение', 'aria-required': true, maxLength: 5000 }}
              />
            </Field>
            <Field
              label="Электронная почта для ответа"
              error={errors.replyTo}
              hint="Необязательно. Укажите адрес, если хотите получить ответ."
            >
              <TextInput
                type="email"
                value={replyTo}
                onUpdate={edit(setReplyTo)}
                placeholder="name@example.ru"
                autoComplete="email"
                disabled={send.isPending}
                validationState={errors.replyTo ? 'invalid' : undefined}
                controlProps={{ 'aria-label': 'Электронная почта для ответа', maxLength: 254 }}
              />
            </Field>
            <ErrorAlert error={send.error} />
          </form>
        )}
      </Dialog.Body>
      {send.isSuccess ? (
        <Dialog.Footer>
          <Button view="action" onClick={close}>
            Закрыть
          </Button>
        </Dialog.Footer>
      ) : (
        <Dialog.Footer
          textButtonApply="Отправить"
          textButtonCancel="Отмена"
          onClickButtonApply={submit}
          onClickButtonCancel={close}
          loading={send.isPending}
          propsButtonApply={{ disabled: send.isPending }}
          propsButtonCancel={{ disabled: send.isPending }}
        />
      )}
    </Dialog>
  );
}
