import { FloppyDisk, Tag } from '@gravity-ui/icons';
import { Alert, Button, Icon, Loader, Text, useToaster } from '@gravity-ui/uikit';
import { DocumentEditor } from '@onlyoffice/document-editor-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../../api/endpoints';
import { errorMessage } from '../../../api/errors';
import { ErrorAlert } from '../../../components/ErrorAlert';
import { pickParams } from '../../../lib/params';
import type { TabProps } from './editorState';
import { templateKey } from './editorState';
import { TagsPanel } from './TagsPanel';

let toastSeq = 0;
const toastName = (prefix: string) => `${prefix}-${++toastSeq}`;

export function DocumentTab({
  template,
  testParams,
  previewData,
  onPreviewData,
  pollMs = 1500,
  pollTimeoutMs = 20_000,
}: TabProps & { pollMs?: number; pollTimeoutMs?: number }) {
  const queryClient = useQueryClient();
  const { add } = useToaster();
  const [showTags, setShowTags] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const polling = useRef(false);
  const mounted = useRef(true);
  const wake = useRef<(() => void) | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      wake.current?.(); // прерываем ожидание следующего шага опроса
    };
  }, []);

  const config = useQuery({
    queryKey: ['editor-config', template.id],
    queryFn: () => api.templates.editorConfig(template.id),
    staleTime: Infinity,
    gcTime: 0,
    refetchOnMount: 'always',
  });
  // Редактор пересоздаётся при любом изменении config — держим ссылку стабильной, пока не сменился ключ документа.
  const key = config.data?.document?.key;
  const stable = useRef<{ key: string | undefined; config: typeof config.data }>({
    key: undefined,
    config: undefined,
  });
  if (stable.current.key !== key || (stable.current.config === undefined && config.data)) {
    stable.current = { key, config: config.data };
  }
  const stableConfig = stable.current.config;

  /** Пауза, которую размонтирование прерывает сразу. */
  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        wake.current = null;
        resolve();
      }, ms);
      wake.current = () => {
        clearTimeout(timer);
        wake.current = null;
        resolve();
      };
    });

  const waitForVersion = async (before: number) => {
    if (polling.current) return;
    polling.current = true;
    setWaiting(true);
    try {
      const deadline = Date.now() + pollTimeoutMs;
      while (Date.now() < deadline) {
        await pause(pollMs);
        if (!mounted.current) return;
        const t = await queryClient.fetchQuery({
          queryKey: templateKey(template.id),
          queryFn: () => api.templates.getAdmin(template.id),
          staleTime: 0,
        });
        if (!mounted.current) return;
        if (t.version > before) {
          void queryClient.invalidateQueries({ queryKey: ['templates'] });
          add({
            name: toastName('doc-save'),
            title: `Сохранено, версия ${t.version}`,
            theme: 'success',
          });
          return;
        }
        if (t.lastSaveError) {
          add({
            name: toastName('doc-save'),
            title: 'Сохранение не удалось',
            content: t.lastSaveError,
            theme: 'danger',
          });
          return;
        }
      }
      add({
        name: toastName('doc-save'),
        title: 'OnlyOffice не подтвердил сохранение',
        content: 'Проверьте версию шаблона чуть позже.',
        theme: 'warning',
      });
    } catch (e) {
      if (mounted.current) {
        add({
          name: toastName('doc-save'),
          title: 'Не удалось проверить сохранение',
          content: errorMessage(e),
          theme: 'danger',
        });
      }
    } finally {
      polling.current = false;
      if (mounted.current) setWaiting(false);
    }
  };

  const save = useMutation({
    mutationFn: () => api.templates.save(template.id),
    onSuccess: () => {
      if (!mounted.current) return;
      add({
        name: toastName('doc-save'),
        title: 'Сохранение запрошено…',
        theme: 'info',
        autoHiding: 3000,
      });
      void waitForVersion(template.version);
    },
    onError: (e) => {
      if (!mounted.current) return;
      add({
        name: toastName('doc-save'),
        title: 'Не удалось сохранить',
        content: errorMessage(e),
        theme: 'danger',
      });
    },
  });

  const refresh = useMutation({
    mutationFn: () =>
      api.templates.previewData(template.id, pickParams(template.params, testParams)),
    onSuccess: (d) => onPreviewData(d),
    onError: (e) => {
      if (!mounted.current) return;
      add({
        name: toastName('tags-refresh'),
        title: 'Данные не получены',
        content: errorMessage(e),
        theme: 'danger',
      });
    },
  });

  const onSave = () => {
    if (polling.current || save.isPending) return;
    save.mutate();
  };

  return (
    <div className="cr-stack">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Button view="action" onClick={onSave} loading={save.isPending || waiting}>
          <Icon data={FloppyDisk} />
          Сохранить
        </Button>
        <Button view={showTags ? 'normal' : 'flat'} onClick={() => setShowTags((v) => !v)}>
          <Icon data={Tag} />
          Теги
        </Button>
        <Text color="secondary" variant="caption-2">
          Изменения попадают в шаблон по кнопке «Сохранить» или автоматически после закрытия
          редактора.
        </Text>
      </div>
      {loadError && (
        <Alert
          theme="danger"
          title="Не удалось загрузить редактор OnlyOffice"
          message={loadError}
        />
      )}
      <ErrorAlert error={config.error} />
      <div style={{ display: 'flex', gap: 16, alignItems: 'stretch' }}>
        <div style={{ flex: 1, height: 'calc(100vh - 260px)', minHeight: 480 }}>
          {stableConfig ? (
            <DocumentEditor
              id="cr-doc-editor"
              documentServerUrl="/onlyoffice/"
              config={stableConfig}
              height="100%"
              width="100%"
              onLoadComponentError={(code, description) =>
                setLoadError(`${description} (код ${code})`)
              }
            />
          ) : (
            config.isPending && <Loader />
          )}
        </div>
        {showTags && (
          <TagsPanel
            data={previewData}
            onRefresh={() => refresh.mutate()}
            refreshing={refresh.isPending}
          />
        )}
      </div>
    </div>
  );
}
