import type { RunSignature } from '@carbone-reports/shared';
import { Dialog, Text, TextInput } from '@gravity-ui/uikit';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
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
    onError: () => setPassword(''),
  });
  const errors = fieldErrors(sign.error);
  const c = cert.data?.certificate;
  return (
    <Dialog open={props.open} onClose={props.onClose} size="s" aria-label="Подписать PDF">
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
            autoFocus
            controlProps={{ 'aria-label': 'Пароль к ключу подписи', autoComplete: 'off' }}
          />
        </Field>
        <ErrorAlert error={sign.error && !errors.password ? sign.error : null} />
      </Dialog.Body>
      <Dialog.Footer
        textButtonApply="Подписать"
        textButtonCancel="Отмена"
        onClickButtonApply={() => sign.mutate()}
        onClickButtonCancel={props.onClose}
        loading={sign.isPending}
        propsButtonApply={{ disabled: password === '' }}
      />
    </Dialog>
  );
}
