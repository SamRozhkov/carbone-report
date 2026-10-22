import type { RunSignature } from '@carbone-reports/shared';
import { Alert, Dialog, Link, Loader, RadioGroup, Text } from '@gravity-ui/uikit';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { ApiRequestError } from '../api/client';
import { api } from '../api/endpoints';
import { formatDate } from '../lib/format';
import { CadesUnavailableError, cadesErrorText, loadCades } from '../lib/cades';

const PLUGIN_URL = 'https://www.cryptopro.ru/products/cades/plugin';
const CSP_URL = 'https://www.cryptopro.ru/products/csp';

/** Ошибка сервера — его текстом (§39.3), ошибка плагина — понятным текстом (§42.7). */
const signErrorText = (e: unknown) =>
  e instanceof ApiRequestError ? e.message : cadesErrorText(e);

function Unavailable() {
  const { t } = useTranslation();
  return (
    <Alert
      theme="danger"
      title={t('signature:cades.unavailable')}
      message={
        <Trans
          t={t}
          i18nKey="signature:dialog.unavailableText"
          components={{
            plugin: <Link href={PLUGIN_URL} target="_blank" rel="noopener noreferrer" />,
            csp: <Link href={CSP_URL} target="_blank" rel="noopener noreferrer" />,
          }}
        />
      }
    />
  );
}

/** Подпись ГОСТ (§42.2): сертификат в плагине → подготовка → подпись хеша плагином → завершение. */
export function SignGostDialog(props: {
  runId: string;
  open: boolean;
  onClose: () => void;
  onSigned: (s: RunSignature) => void;
}) {
  const { t } = useTranslation();
  const [picked, setPicked] = useState<string | null>(null);
  const plugin = useQuery({
    queryKey: ['cades-certificates'],
    queryFn: async () => {
      const cades = await loadCades();
      return { cades, certs: await cades.listCertificates() };
    },
    enabled: props.open,
    retry: false,
    staleTime: 0,
    gcTime: 0,
    // Объект плагина — не данные: без структурного сравнения.
    structuralSharing: false,
  });
  const certs = plugin.data?.certs ?? [];
  const thumbprint = picked ?? certs[0]?.thumbprint ?? null;
  const cert = certs.find((c) => c.thumbprint === thumbprint) ?? null;

  const sign = useMutation({
    mutationFn: async () => {
      const { cades } = plugin.data!;
      const p = await api.runs.gostPrepare(props.runId, cert!.certificateBase64);
      const signature = await cades.signHash(cert!.thumbprint, p.hash, p.hashAlg, p.tsaUrl);
      return api.runs.gostComplete(props.runId, signature);
    },
    onSuccess: (s) => props.onSigned(s),
  });
  const canSubmit = cert !== null && !sign.isPending;
  const close = () => {
    sign.reset();
    props.onClose();
  };

  let body;
  if (plugin.isPending) {
    body = (
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Loader size="s" />
        <Text color="secondary">{t('signature:dialog.connecting')}</Text>
      </div>
    );
  } else if (plugin.error) {
    body =
      plugin.error instanceof CadesUnavailableError ? (
        <Unavailable />
      ) : (
        <Alert theme="danger" message={cadesErrorText(plugin.error)} />
      );
  } else if (certs.length === 0) {
    body = <Alert theme="warning" message={t('signature:dialog.noCertificates')} />;
  } else {
    body = (
      <RadioGroup
        direction="vertical"
        aria-label={t('signature:dialog.certificate')}
        value={thumbprint ?? undefined}
        onUpdate={setPicked}
        disabled={sign.isPending}
        options={certs.map((c) => ({
          value: c.thumbprint,
          content: (
            <span>
              {c.subjectCn}
              <Text as="div" color="secondary" variant="caption-2">
                {t('signature:dialog.validUntil', {
                  name: c.issuerCn,
                  date: formatDate(c.validTo.toISOString()),
                })}
              </Text>
            </span>
          ),
        }))}
      />
    );
  }

  return (
    <Dialog open={props.open} onClose={close} size="m" aria-label={t('signature:dialog.title')}>
      <Dialog.Header caption={t('signature:dialog.title')} />
      <Dialog.Body className="cr-stack">
        {body}
        {sign.isPending && (
          <Text as="p" color="secondary">
            {t('signature:dialog.confirmInPlugin')}
          </Text>
        )}
        {sign.error && <Alert theme="danger" message={signErrorText(sign.error)} />}
        <Text as="p" color="secondary">
          {t('signature:dialog.authenticityNote')}
        </Text>
      </Dialog.Body>
      <Dialog.Footer
        textButtonApply={t('signature:dialog.submit')}
        textButtonCancel={t('common:action.cancel')}
        onClickButtonApply={() => {
          if (canSubmit) sign.mutate();
        }}
        onClickButtonCancel={close}
        loading={sign.isPending}
        propsButtonApply={{ disabled: cert === null }}
      />
    </Dialog>
  );
}
