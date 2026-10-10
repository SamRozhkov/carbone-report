import { Alert, Dialog, Text } from '@gravity-ui/uikit';
import { useQuery } from '@tanstack/react-query';
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
  return (
    <Text as="div">
      {label}: <Text variant="body-2">{value}</Text>
    </Text>
  );
}

export function AboutDialog({ open, onClose, web = webBuild }: AboutDialogProps) {
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
      <Dialog.Header caption="О программе" id="cr-about-title" />
      <Dialog.Body>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Text as="div" variant="subheader-2">
            Интерфейс
          </Text>
          <Row label="Версия" value={web.version} />
          <Row label="Коммит" value={web.commit} />
          <Row label="Дата сборки" value={web.builtAt} />
          <Text as="div" variant="subheader-2">
            Сервер
          </Text>
          {server.isPending && server.fetchStatus !== 'idle' && (
            <Text as="div" color="secondary">
              Загрузка…
            </Text>
          )}
          {server.isError && <Text as="div">Версия сервера недоступна</Text>}
          {server.data && (
            <>
              <Row label="Версия" value={server.data.version} />
              <Row label="Коммит" value={server.data.commit} />
            </>
          )}
          {mismatch && (
            <Alert
              theme="warning"
              message="Версии интерфейса и сервера различаются — обновите страницу или проверьте развёртывание"
            />
          )}
          <Text as="div">Лицензия: PolyForm Strict 1.0.0</Text>
        </div>
      </Dialog.Body>
    </Dialog>
  );
}
