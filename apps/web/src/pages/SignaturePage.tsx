import type { CertificateInfo } from '@carbone-reports/shared';
import { CERT_EXPIRY_WARNING_DAYS } from '@carbone-reports/shared';
import { Alert, Button, Card, Loader, Text, TextInput } from '@gravity-ui/uikit';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/endpoints';
import { fieldErrors } from '../api/errors';
import { CadesCheck } from '../components/CadesCheck';
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
  const { t } = useTranslation();
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
      <Field label={t('signature:upload.file')} error={errors.file}>
        <input
          ref={fileInput}
          type="file"
          accept=".p12,.pfx"
          aria-label={t('signature:upload.file')}
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
      </Field>
      <Field label={t('signature:upload.password')} error={errors.password}>
        <TextInput
          type="password"
          value={password}
          onUpdate={setPassword}
          autoComplete="new-password"
          validationState={errors.password ? 'invalid' : undefined}
          controlProps={{ 'aria-label': t('signature:upload.password') }}
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
          {t('signature:upload.submit')}
        </Button>
        {onCancel && <Button onClick={onCancel}>{t('common:action.cancel')}</Button>}
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
  const { t } = useTranslation();
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
      <PageHeader title={t('signature:page.title')} />
      <ErrorAlert error={query.error} />
      {query.isPending ? (
        <Loader />
      ) : !cert ? (
        <div className="cr-form">
          <Text as="p">{t('signature:page.intro')}</Text>
          <UploadForm onDone={() => undefined} />
        </div>
      ) : (
        <div className="cr-form">
          {state === 'expiring' && (
            <Alert
              theme="warning"
              message={t('signature:page.expiring', { date: formatDate(cert.notAfter) })}
            />
          )}
          {state === 'expired' && <Alert theme="danger" message={t('signature:page.expired')} />}
          <Card view="outlined" style={{ padding: 16, display: 'grid', gap: 8 }}>
            <Row label={t('signature:page.owner')}>{cert.subjectCn}</Row>
            <Row label={t('signature:page.issuer')}>{cert.issuer}</Row>
            <Row label={t('signature:page.serial')}>{cert.serial}</Row>
            <Row label={t('signature:page.validity')}>
              {t('signature:page.validRange', {
                from: formatDate(cert.notBefore),
                to: formatDate(cert.notAfter),
              })}
            </Row>
            <Row label={t('signature:page.algorithm')}>{cert.keyAlg}</Row>
            <Row label={t('signature:page.fingerprint')} mono>
              {cert.fingerprint}
            </Row>
          </Card>
          <div style={{ display: 'flex', gap: 8 }}>
            <Button onClick={() => setReplacing((v) => !v)}>{t('signature:page.replace')}</Button>
            <Button view="outlined-danger" onClick={() => setConfirming(true)}>
              {t('common:action.delete')}
            </Button>
          </div>
          {replacing && (
            <UploadForm onDone={() => setReplacing(false)} onCancel={() => setReplacing(false)} />
          )}
        </div>
      )}
      <ConfirmDialog
        open={confirming}
        title={t('signature:page.deleteTitle')}
        text={t('signature:page.deleteText')}
        confirmText={t('common:action.delete')}
        danger
        loading={remove.isPending}
        onConfirm={() => remove.mutate()}
        onCancel={() => setConfirming(false)}
      />
      {remove.error && <ErrorAlert error={remove.error} />}
      <div className="cr-form" style={{ marginTop: 24 }}>
        <CadesCheck />
      </div>
    </>
  );
}
