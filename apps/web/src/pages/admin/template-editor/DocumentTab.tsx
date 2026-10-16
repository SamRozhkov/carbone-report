import { ChevronsCollapseUpRight, ChevronsExpandUpRight, FloppyDisk, Tag } from '@gravity-ui/icons';
import { Alert, Button, Icon, Link, Loader, Text, useToaster } from '@gravity-ui/uikit';
import { DocumentEditor } from '@onlyoffice/document-editor-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../../api/endpoints';
import { ApiRequestError } from '../../../api/client';
import { errorMessage } from '../../../api/errors';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { ErrorAlert } from '../../../components/ErrorAlert';
import { pickParams } from '../../../lib/params';
import type { TabProps } from './editorState';
import { templateKey } from './editorState';
import { TagsPanel } from './TagsPanel';
import type { EditLock } from './useEditLock';

let toastSeq = 0;
const toastName = (prefix: string) => `${prefix}-${++toastSeq}`;

export function DocumentTab({
  template,
  testParams,
  previewData,
  onPreviewData,
  pollMs = 1500,
  pollTimeoutMs = 20_000,
  full,
  onFull,
  lock,
}: TabProps & {
  /** Блокировка страницы (живёт в TemplateEditorPage): её держит эта вкладка, пока открыта страница шаблона. */
  lock: EditLock;
  pollMs?: number;
  pollTimeoutMs?: number;
  full: boolean;
  onFull: (v: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const { add } = useToaster();
  const [showTags, setShowTags] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const [confirmTakeover, setConfirmTakeover] = useState(false);
  const [busy, setBusy] = useState(false);
  const [readyId, setReadyId] = useState<string | null>(null);
  // Незначимый проп для принудительной пересборки: название фиксируем в момент пересборки, иначе переименование
  // шаблона меняло бы проп и ещё раз пересоздавало редактор, теряя несохранённые правки.
  const [rebuildTitle, setRebuildTitle] = useState<string | undefined>(undefined);
  const mode = lock.state === null ? null : lock.editing ? 'edit' : 'view';
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
    queryKey: ['editor-config', template.id, lock.holder, mode],
    queryFn: () => api.templates.editorConfig(template.id, lock.holder),
    enabled: mode !== null,
    staleTime: Infinity,
    gcTime: 0,
    refetchOnMount: 'always',
  });
  // Библиотека пересоздаёт редактор, когда СОДЕРЖИМОЕ config меняется (сравнивает JSON), поэтому держим конфиг неизменным,
  // пока не сменились ключ документа или режим (иначе каждый новый токен JWT перезагружал бы документ).
  // React key на DocumentEditor ставить нельзя: перемонтирование ломает DocsAPI («removeChild»).
  const key = config.data?.document?.key;
  const stableId = `${mode}:${key}`;
  const stable = useRef<{ id: string | undefined; config: typeof config.data }>({
    id: undefined,
    config: undefined,
  });
  if (config.data && stable.current.id !== stableId) {
    stable.current = { id: stableId, config: config.data };
  }
  const stableConfig = stable.current.config;

  // Библиотека строит редактор из конфига того рендера, где загрузился api.js; смена режима за время загрузки
  // её не затрагивает. Поэтому готовность помним по id конфига, с которым редактор построен (колбэк замыкает id своего
  // рендера), а «Забрать»/«Начать» разрешаем только когда редактор построен под актуальный режим.
  const currentId = useRef(stableId);
  currentId.current = stableId;
  const onAppReady = () => {
    setReadyId(stableId);
    // Построен по устаревшему конфигу — принудительная пересборка: смена незначимого пропа заставляет библиотеку
    // уничтожить редактор и построить его заново из актуального конфига.
    if (stableId !== currentId.current)
      setRebuildTitle((v) => (v === undefined ? template.name : undefined));
  };
  const editorReady = config.data !== undefined && readyId === stableId;
  const canSwitch = editorReady || loadError !== null || config.isError;

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

  const runSave = async () => {
    if (polling.current) return;
    polling.current = true;
    setWaiting(true);
    try {
      // Свежая база: версия и прошлая ошибка сохранения (бэкенд сбрасывает её только после успешного callback).
      const fresh = () =>
        queryClient.fetchQuery({
          queryKey: templateKey(template.id),
          queryFn: () => api.templates.getAdmin(template.id),
          staleTime: 0,
        });
      const base = await fresh();
      if (!mounted.current) return;
      try {
        await save.mutateAsync();
      } catch (e) {
        if (mounted.current && e instanceof ApiRequestError && e.code === 'NO_CHANGES') {
          add({
            name: toastName('doc-save'),
            title: 'Нет несохранённых изменений',
            theme: 'info',
            autoHiding: 3000,
          });
        } else if (mounted.current) {
          add({
            name: toastName('doc-save'),
            title: 'Не удалось сохранить',
            content: errorMessage(e),
            theme: 'danger',
          });
        }
        return;
      }
      if (!mounted.current) return;
      add({
        name: toastName('doc-save'),
        title: 'Сохранение запрошено…',
        theme: 'info',
        autoHiding: 3000,
      });
      const deadline = Date.now() + pollTimeoutMs;
      while (Date.now() < deadline) {
        await pause(pollMs);
        if (!mounted.current) return;
        const t = await fresh();
        if (!mounted.current) return;
        if (t.version > base.version) {
          void queryClient.invalidateQueries({ queryKey: ['templates'] });
          add({
            name: toastName('doc-save'),
            title: `Сохранено, версия ${t.version}`,
            theme: 'success',
          });
          return;
        }
        // Новая ошибка — новая метка времени; текст не сравниваем: повтор той же ошибки тоже провал (§22.7).
        if (t.lastSaveErrorAt !== null && t.lastSaveErrorAt !== base.lastSaveErrorAt) {
          add({
            name: toastName('doc-save'),
            title: 'Сохранение не удалось',
            content: t.lastSaveError ?? '',
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

  const save = useMutation({ mutationFn: () => api.templates.save(template.id, lock.holder) });

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

  const onSave = () => void runSave();
  const doTakeover = () => {
    if (busy) return;
    setBusy(true);
    lock
      .takeover()
      .catch((e) => {
        if (!mounted.current) return;
        add({
          name: toastName('doc-takeover'),
          title: 'Не удалось забрать редактирование',
          content: errorMessage(e),
          theme: 'danger',
        });
      })
      .finally(() => {
        if (mounted.current) setBusy(false);
      });
  };
  const doStart = () => {
    if (busy) return;
    setBusy(true);
    void lock.start().finally(() => {
      if (mounted.current) setBusy(false);
    });
  };
  const holderLogin = lock.state?.state === 'other' ? lock.state.user.login : '';

  // Версия шаблона изменилась (сохранение, замена файла в «Настройках»): ключ документа мог смениться.
  // Если ключ тот же, ссылка на конфиг не меняется и редактор не пересоздаётся.
  const lastVersion = useRef(template.version);
  const { refetch } = config;
  useEffect(() => {
    if (lastVersion.current === template.version) return;
    lastVersion.current = template.version;
    void refetch();
  }, [template.version, refetch]);

  // Esc из iframe OnlyOffice сюда не доходит — это и нужно (в редакторе Esc принадлежит ему).
  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onFull(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [full, onFull]);

  return (
    <div className={full ? 'cr-stack cr-doc-full' : 'cr-stack'}>
      <div className="cr-doc-bar">
        {full && (
          <Text variant="subheader-2" ellipsis>
            {template.name}
          </Text>
        )}
        <LockBar
          lock={lock}
          onTakeover={() => setConfirmTakeover(true)}
          onTakeoverHere={doTakeover}
          onStart={doStart}
          disabled={!canSwitch}
          busy={busy}
        />
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          {lock.editing && (
            <Button view="action" onClick={onSave} loading={waiting}>
              <Icon data={FloppyDisk} />
              Сохранить
            </Button>
          )}
          <Button
            view={showTags ? 'normal' : 'flat'}
            aria-pressed={showTags}
            onClick={() => setShowTags((v) => !v)}
          >
            <Icon data={Tag} />
            Теги
          </Button>
          <Button onClick={() => onFull(!full)}>
            <Icon data={full ? ChevronsCollapseUpRight : ChevronsExpandUpRight} />
            {full ? 'Свернуть' : 'Развернуть'}
          </Button>
        </div>
      </div>
      {!full && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {/* Новая вкладка: документ OnlyOffice в этой вкладке остаётся открытым (§23.1). */}
          <Link href="/admin/help" target="_blank" rel="noopener">
            Справка по синтаксису
          </Link>
          <Text color="secondary" variant="caption-2">
            Изменения попадают в шаблон по кнопке «Сохранить» или автоматически после закрытия
            редактора.
          </Text>
        </div>
      )}
      {loadError && (
        <Alert
          theme="danger"
          title="Не удалось загрузить редактор OnlyOffice"
          message={loadError}
        />
      )}
      <ErrorAlert error={config.error} />
      {config.error && (
        <div>
          <Button onClick={() => void config.refetch()}>Повторить</Button>
        </div>
      )}
      <div className="cr-doc-body">
        <div className="cr-doc-editor">
          {stableConfig ? (
            <DocumentEditor
              id="cr-doc-editor"
              documentServerUrl="/onlyoffice/"
              config={stableConfig}
              height="100%"
              width="100%"
              document_title={rebuildTitle}
              events_onAppReady={onAppReady}
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
            charts={template.charts.map((c) => c.key)}
            onRefresh={() => refresh.mutate()}
            refreshing={refresh.isPending}
            editing={lock.editing}
          />
        )}
      </div>
      <ConfirmDialog
        open={confirmTakeover}
        title="Забрать редактирование"
        text={`Шаблон сейчас редактирует ${holderLogin}. Забрать редактирование? Сделанные правки будут сохранены, а у ${holderLogin} редактор переключится в просмотр`}
        confirmText="Забрать"
        onCancel={() => setConfirmTakeover(false)}
        onConfirm={() => {
          setConfirmTakeover(false);
          doTakeover();
        }}
      />
    </div>
  );
}

function LockBar({
  lock,
  onTakeover,
  onTakeoverHere,
  onStart,
  disabled,
  busy,
}: {
  lock: EditLock;
  onTakeover: () => void;
  onTakeoverHere: () => void;
  onStart: () => void;
  /** Редактор ещё не построен под текущий режим. */
  disabled: boolean;
  /** Идёт перехват или захват. */
  busy: boolean;
}) {
  const s = lock.state;
  if (!s) return null;
  const time = (iso: string) =>
    new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
      {s.state === 'mine' && <Text color="positive">Вы редактируете</Text>}
      {s.state === 'other' && !s.sameUser && (
        <>
          <Text color="warning">
            Только просмотр — редактирует {s.user.login} с {time(s.since)}
          </Text>
          <Button size="s" onClick={onTakeover} disabled={disabled} loading={busy}>
            Забрать редактирование
          </Button>
        </>
      )}
      {s.state === 'other' && s.sameUser && (
        <>
          <Text color="warning">Шаблон открыт у вас в другой вкладке</Text>
          <Button size="s" onClick={onTakeoverHere} disabled={disabled} loading={busy}>
            Редактировать здесь
          </Button>
        </>
      )}
      {s.state === 'free' && (
        <>
          <Text color="secondary">Документ свободен</Text>
          <Button size="s" view="action" onClick={onStart} disabled={disabled} loading={busy}>
            Начать редактирование
          </Button>
        </>
      )}
      {lock.lostTo && s.state !== 'mine' && (
        <Text color="danger">Редактирование забрал {lock.lostTo}</Text>
      )}
      {lock.offline && (
        <Text color="danger">Связь с сервером потеряна, изменения могут не сохраниться</Text>
      )}
    </div>
  );
}
