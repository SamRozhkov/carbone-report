import { Alert, Dialog, Text } from '@gravity-ui/uikit';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../api/endpoints';
import type { BuildInfo } from './buildInfo';
import { webBuild } from './buildInfo';

export interface AboutDialogProps {
  open: boolean;
  onClose: () => void;
  /** Сборка интерфейса; в тестах подменяется. */
  web?: BuildInfo;
}

function Row({ label, value }: { label: string; value: string }) {
  const { t } = useTranslation();
  return (
    <Text as="div">
      {t('common:labelValue', { label })} <Text variant="body-2">{value}</Text>
    </Text>
  );
}

export function AboutDialog({ open, onClose, web = webBuild }: AboutDialogProps) {
  const { t } = useTranslation();
  const server = useQuery({
    queryKey: ['version'],
    queryFn: api.version,
    enabled: open,
    retry: false,
  });
  const mismatch =
    server.data !== undefined &&
    (server.data.version !== web.version || server.data.commit !== web.commit);

  return (
    <Dialog open={open} onClose={onClose} aria-labelledby="cr-about-title" size="s">
      <Dialog.Header caption={t('common:about.title')} id="cr-about-title" />
      <Dialog.Body>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Text as="div" variant="subheader-2">
            {t('common:about.web')}
          </Text>
          <Row label={t('common:about.version')} value={web.version} />
          <Row label={t('common:about.commit')} value={web.commit} />
          <Row label={t('common:about.builtAt')} value={web.builtAt} />
          <Text as="div" variant="subheader-2">
            {t('common:about.server')}
          </Text>
          {server.isPending && server.fetchStatus !== 'idle' && (
            <Text as="div" color="secondary">
              {t('common:status.loading')}
            </Text>
          )}
          {server.isError && <Text as="div">{t('common:about.serverUnavailable')}</Text>}
          {server.data && (
            <>
              <Row label={t('common:about.version')} value={server.data.version} />
              <Row label={t('common:about.commit')} value={server.data.commit} />
            </>
          )}
          {mismatch && <Alert theme="warning" message={t('common:about.mismatch')} />}
          <Text as="div">{t('common:about.license', { license: 'PolyForm Strict 1.0.0' })}</Text>
        </div>
      </Dialog.Body>
    </Dialog>
  );
}
