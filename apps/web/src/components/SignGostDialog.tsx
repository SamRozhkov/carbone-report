import type { RunSignature } from '@carbone-reports/shared';
import { Alert, Dialog, Link, Loader, RadioGroup, Text } from '@gravity-ui/uikit';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ApiRequestError } from '../api/client';
import { api } from '../api/endpoints';
import { formatDate } from '../lib/format';
import { CadesUnavailableError, cadesErrorText, loadCades } from '../lib/cades';

const PLUGIN_URL = 'https://www.cryptopro.ru/products/cades/plugin';
const CSP_URL = 'https://www.cryptopro.ru/products/csp';
export const GOST_AUTHENTICITY_NOTE =
  'Подлинность сертификата проверяется сервисом проверки подписи (например, Госуслуги)';

/** Ошибка сервера — его текстом (§39.3), ошибка плагина — понятным текстом (§42.7). */
const signErrorText = (e: unknown) =>
  e instanceof ApiRequestError ? e.message : cadesErrorText(e);

function Unavailable() {
  return (
    <Alert
      theme="danger"
      title="Не найден КриптоПро ЭЦП Browser plug-in или КриптоПро CSP"
      message={
        <>
          Установите{' '}
          <Link href={PLUGIN_URL} target="_blank" rel="noopener noreferrer">
            КриптоПро ЭЦП Browser plug-in
          </Link>{' '}
          (с расширением для браузера) и{' '}
          <Link href={CSP_URL} target="_blank" rel="noopener noreferrer">
            КриптоПро CSP
          </Link>
          . Когда браузер спросит, разрешите сайту доступ к плагину, затем обновите страницу.
        </>
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
        <Text color="secondary">Подключение к КриптоПро…</Text>
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
    body = (
      <Alert
        theme="warning"
        message="Нет действующих сертификатов ГОСТ — установите сертификат в КриптоПро"
      />
    );
  } else {
    body = (
      <RadioGroup
        direction="vertical"
        aria-label="Сертификат"
        value={thumbprint ?? undefined}
        onUpdate={setPicked}
        disabled={sign.isPending}
        options={certs.map((c) => ({
          value: c.thumbprint,
          content: (
            <span>
              {c.subjectCn}
              <Text as="div" color="secondary" variant="caption-2">
                {c.issuerCn}, действителен до {formatDate(c.validTo.toISOString())}
              </Text>
            </span>
          ),
        }))}
      />
    );
  }

  return (
    <Dialog open={props.open} onClose={close} size="m" aria-label="Подписать PDF">
      <Dialog.Header caption="Подписать PDF" />
      <Dialog.Body className="cr-stack">
        {body}
        {sign.isPending && (
          <Text as="p" color="secondary">
            Подтвердите подпись в окне КриптоПро, если оно появится
          </Text>
        )}
        {sign.error && <Alert theme="danger" message={signErrorText(sign.error)} />}
        <Text as="p" color="secondary">
          {GOST_AUTHENTICITY_NOTE}
        </Text>
      </Dialog.Body>
      <Dialog.Footer
        textButtonApply="Подписать"
        textButtonCancel="Отмена"
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
