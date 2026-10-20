import type { CertificateInfo } from '@carbone-reports/shared';
import { CERT_EXPIRY_WARNING_DAYS } from '@carbone-reports/shared';
import { Alert, Button, Card, Loader, Text, TextInput } from '@gravity-ui/uikit';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { api } from '../api/endpoints';
import { fieldErrors } from '../api/errors';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { ErrorAlert } from '../components/ErrorAlert';
import { Field } from '../components/Field';
import { GeneralError } from '../components/GeneralError';
import { PageHeader } from '../components/PageHeader';
import { formatDate } from '../lib/format';

export const myCertificateKey = ['my-certificate'] as const;

export function certificateState(
  c: CertificateInfo,
  now = new Date(),
): 'ok' | 'expiring' | 'expired' {
  const end = new Date(c.notAfter).getTime();
  if (end <= now.getTime()) return 'expired';
  return end - now.getTime() < CERT_EXPIRY_WARNING_DAYS * 86_400_000 ? 'expiring' : 'ok';
}

function UploadForm({ onDone, onCancel }: { onDone: () => void; onCancel?: () => void }) {
  const queryClient = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const upload = useMutation({
    mutationFn: () => {
      const form = new FormData();
      form.append('password', password);
      form.append('file', file!);
      return api.signature.upload(form);
    },
    onSuccess: (certificate) => {
      queryClient.setQueryData(myCertificateKey, { certificate });
      setFile(null);
      setPassword('');
      if (fileInput.current) fileInput.current.value = '';
      onDone();
    },
  });
  const errors = fieldErrors(upload.error);

  return (
    <form
      className="cr-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (file && password) upload.mutate();
      }}
    >
      <Field label="Файл сертификата" error={errors.file}>
        <input
          ref={fileInput}
          type="file"
          accept=".p12,.pfx"
          aria-label="Файл сертификата"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </Field>
      <Field label="Пароль к файлу" error={errors.password}>
        <TextInput
          type="password"
          value={password}
          onUpdate={setPassword}
          autoComplete="new-password"
          validationState={errors.password ? 'invalid' : undefined}
          controlProps={{ 'aria-label': 'Пароль к файлу' }}
        />
      </Field>
      <GeneralError error={upload.error} errors={errors} shown={['file', 'password']} />
      <div style={{ display: 'flex', gap: 8 }}>
        <Button
          type="submit"
          view="action"
          loading={upload.isPending}
          disabled={!file || !password}
        >
          Загрузить сертификат
        </Button>
        {onCancel && <Button onClick={onCancel}>Отмена</Button>}
      </div>
    </form>
  );
}

function Row({ label, children, mono }: { label: string; children: string; mono?: boolean }) {
  return (
    <div style={{ display: 'flex', gap: 16 }}>
      <Text color="secondary" style={{ minWidth: 160 }}>
        {label}
      </Text>
      <Text style={mono ? { fontFamily: 'monospace', wordBreak: 'break-all' } : undefined}>
        {children}
      </Text>
    </div>
  );
}

export function SignaturePage() {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: myCertificateKey, queryFn: api.signature.get });
  const [replacing, setReplacing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const remove = useMutation({
    mutationFn: api.signature.remove,
    onSuccess: async () => {
      setConfirming(false);
      setReplacing(false);
      await queryClient.invalidateQueries({ queryKey: myCertificateKey });
    },
  });
  const cert = query.data?.certificate ?? null;
  const state = cert ? certificateState(cert) : 'ok';

  return (
    <>
      <PageHeader title="Моя подпись" />
      <ErrorAlert error={query.error} />
      {query.isPending ? (
        <Loader />
      ) : !cert ? (
        <div className="cr-form">
          <Text as="p">
            Нужен файл .p12 или .pfx с закрытым ключом — его выдаёт удостоверяющий центр или
            ИТ-служба
          </Text>
          <UploadForm onDone={() => undefined} />
        </div>
      ) : (
        <div className="cr-form">
          {state === 'expiring' && (
            <Alert
              theme="warning"
              message={`Срок действия сертификата заканчивается ${formatDate(cert.notAfter)}`}
            />
          )}
          {state === 'expired' && (
            <Alert theme="danger" message="Срок действия сертификата истёк — загрузите новый" />
          )}
          <Card view="outlined" style={{ padding: 16, display: 'grid', gap: 8 }}>
            <Row label="Владелец">{cert.subjectCn}</Row>
            <Row label="Издатель">{cert.issuer}</Row>
            <Row label="Серийный номер">{cert.serial}</Row>
            <Row label="Действителен">
              {`с ${formatDate(cert.notBefore)} по ${formatDate(cert.notAfter)}`}
            </Row>
            <Row label="Алгоритм">{cert.keyAlg}</Row>
            <Row label="Отпечаток SHA-256" mono>
              {cert.fingerprint}
            </Row>
          </Card>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button onClick={() => setReplacing((v) => !v)}>Заменить</Button>
            <Button view="outlined-danger" onClick={() => setConfirming(true)}>
              Удалить
            </Button>
          </div>
          {replacing && (
            <UploadForm onDone={() => setReplacing(false)} onCancel={() => setReplacing(false)} />
          )}
        </div>
      )}
      <ConfirmDialog
        open={confirming}
        title="Удалить сертификат подписи?"
        text="Подписывать PDF будет нельзя, пока не загрузите новый сертификат."
        confirmText="Удалить"
        danger
        loading={remove.isPending}
        onConfirm={() => remove.mutate()}
        onCancel={() => setConfirming(false)}
      />
      {remove.error && <ErrorAlert error={remove.error} />}
    </>
  );
}
