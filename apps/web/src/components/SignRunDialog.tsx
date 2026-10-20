import type { RunSignature } from '@carbone-reports/shared';
import { Dialog, Text, TextInput } from '@gravity-ui/uikit';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiRequestError } from '../api/client';
import { api } from '../api/endpoints';
import { fieldErrors } from '../api/errors';
import { formatDate } from '../lib/format';
import { myCertificateKey } from '../pages/SignaturePage';
import { ErrorAlert } from './ErrorAlert';
import { Field } from './Field';

export function SignRunDialog(props: {
  runId: string;
  open: boolean;
  onClose: () => void;
  onSigned: (s: RunSignature) => void;
}) {
  const [password, setPassword] = useState('');
  const cert = useQuery({
    queryKey: myCertificateKey,
    queryFn: api.signature.get,
    enabled: props.open,
  });
  const sign = useMutation({
    mutationFn: () => api.runs.sign(props.runId, password),
    onSuccess: (s) => {
      setPassword('');
      props.onSigned(s);
    },
    // Занято другой подписью (§39.8) — пароль верен или ещё не проверен: повторить без ввода заново.
    onError: (e) => {
      if (!(e instanceof ApiRequestError && e.code === 'SIGN_BUSY')) setPassword('');
    },
  });
  const errors = fieldErrors(sign.error);
  const c = cert.data?.certificate;
  const canSubmit = password !== '' && !sign.isPending;
  const submit = () => {
    if (canSubmit) sign.mutate();
  };
  // Отмена и Esc: введённый пароль и прежняя ошибка не остаются до следующего открытия.
  const close = () => {
    setPassword('');
    sign.reset();
    props.onClose();
  };
  return (
    <Dialog open={props.open} onClose={close} size="s" aria-label="Подписать PDF">
      <Dialog.Header caption="Подписать PDF" />
      <Dialog.Body>
        {c && (
          <Text as="p" color="secondary">
            {c.subjectCn}, действителен до {formatDate(c.notAfter)}
          </Text>
        )}
        <Field label="Пароль к ключу подписи" error={errors.password}>
          <TextInput
            type="password"
            value={password}
            onUpdate={setPassword}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submit();
              }
            }}
            autoFocus
            autoComplete="new-password"
            controlProps={{ 'aria-label': 'Пароль к ключу подписи' }}
          />
        </Field>
        <ErrorAlert error={sign.error && !errors.password ? sign.error : null} />
      </Dialog.Body>
      <Dialog.Footer
        textButtonApply="Подписать"
        textButtonCancel="Отмена"
        onClickButtonApply={submit}
        onClickButtonCancel={close}
        loading={sign.isPending}
        propsButtonApply={{ disabled: password === '' }}
      />
    </Dialog>
  );
}
