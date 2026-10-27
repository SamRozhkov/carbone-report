import { ArrowDownToLine } from '@gravity-ui/icons';
import {
  Alert,
  Button,
  Icon,
  Label,
  Loader,
  Tab,
  TabList,
  TabProvider,
  Text,
} from '@gravity-ui/uikit';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { ApiRequestError } from '../../../api/client';
import { api, templateDownloadUrl } from '../../../api/endpoints';
import { ErrorAlert } from '../../../components/ErrorAlert';
import { useOptionalAssistantBridge } from '../../../features/assistant/bridge';
import { ExportTemplatesButton } from '../ExportTemplatesButton';
import { ChartsTab } from './ChartsTab';
import { PdfTab } from './PdfTab';
import { DataTab } from './DataTab';
import { DocumentTab } from './DocumentTab';
import { templateKey, usePreviewData, useTestParams } from './editorState';
import { ParamsTab } from './ParamsTab';
import { PreviewTab } from './PreviewTab';
import { useEditLock } from './useEditLock';
import { SettingsTab } from './SettingsTab';

const TABS = ['document', 'data', 'charts', 'pdf', 'params', 'preview', 'settings'] as const;
type TabId = (typeof TABS)[number];

export function TemplateEditorPage() {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [sp, setSp] = useSearchParams();
  const raw = sp.get('tab');
  const tab: TabId = (TABS as readonly string[]).includes(raw ?? '') ? (raw as TabId) : 'document';
  const full = tab === 'document' && sp.get('full') === '1';
  const [documentVisited, setDocumentVisited] = useState(tab === 'document');
  if (tab === 'document' && !documentVisited) setDocumentVisited(true);

  // После display:none iframe OnlyOffice не знает свой размер: просим пересчитать раскладку, когда вкладка снова видна.
  useEffect(() => {
    if (tab === 'document') window.dispatchEvent(new Event('resize'));
  }, [tab, full]);

  const template = useQuery({
    queryKey: templateKey(id),
    queryFn: () => api.templates.getAdmin(id),
  });
  // Шаблон видим по §19, но не редактируем: API отдаёт DTO пользователя без запросов (§43.3).
  const forbidden =
    (!!template.data && !('queries' in template.data)) ||
    (template.error instanceof ApiRequestError && template.error.status === 403);
  const tpl = forbidden ? undefined : template.data;
  const [testParams, setTestParams] = useTestParams(id, tpl?.params ?? []);
  const [previewData, setPreviewData] = usePreviewData(id);

  // Блокировка живёт на уровне страницы: переключение вкладок её не снимает, уход со страницы снимает.
  // Берём только после первого захода на «Документ» и когда шаблон загружен.
  const lock = useEditLock(id, documentVisited && !!tpl);

  // Предупреждение перечитывается с новой версией файла (загрузка, замена, сохранение из OnlyOffice).
  // Ошибка запроса не показывается: подсказка необязательна.
  const tagWarnings = useQuery({
    queryKey: ['template-tag-warnings', id, tpl?.version],
    queryFn: () => api.templates.tagWarnings(id),
    enabled: !!tpl,
    retry: false,
  });
  const warned = tagWarnings.data;

  // Мост ассистента (§51.5): открытый редактор виден панели; переключение вкладки — через ref,
  // чтобы регистрация не менялась при каждой смене параметров адреса.
  const bridge = useOptionalAssistantBridge();
  const registerEditor = bridge?.registerEditor;
  // Уход из редактора сбрасывает очередь карточек: иначе она применится при следующем заходе.
  const clearPending = bridge?.clearPending;
  useEffect(() => () => clearPending?.(), [clearPending]);
  const openTabRef = useRef<(tab: 'data' | 'params') => void>(() => {});
  useEffect(() => {
    if (!registerEditor || !tpl) return;
    return registerEditor({
      templateId: tpl.id,
      templateName: tpl.name,
      saved: () => ({
        queries: tpl.queries.map(({ key, mode, sql }) => ({ key, mode, sql })),
        params: tpl.params,
      }),
      openTab: (t) => openTabRef.current(t),
    });
  }, [registerEditor, tpl]);

  if (template.isPending) return <Loader />;
  if (forbidden) {
    return (
      <Alert
        theme="danger"
        title={t('editor:page.openFailed')}
        message={t('editor:page.noEditRight')}
        actions={
          <Button view="outlined" onClick={() => navigate('/admin/templates')}>
            {t('editor:page.toList')}
          </Button>
        }
      />
    );
  }
  if (!tpl) return <ErrorAlert error={template.error} title={t('editor:page.openFailed')} />;

  const selectTab = (value: string) => {
    const next = new URLSearchParams(sp);
    next.set('tab', value);
    next.delete('full');
    setSp(next, { replace: true });
  };
  openTabRef.current = selectTab;
  const setFull = (v: boolean) => {
    const next = new URLSearchParams(sp);
    if (v) next.set('full', '1');
    else next.delete('full');
    setSp(next, { replace: true });
  };
  const tabProps = {
    template: tpl,
    testParams,
    onTestParams: setTestParams,
    previewData,
    onPreviewData: setPreviewData,
  };

  return (
    <>
      <div className="cr-editor-head">
        <Button view="flat" onClick={() => navigate('/admin/templates')}>
          {t('editor:page.back')}
        </Button>
        <Text variant="header-1" as="h1">
          {tpl.name}
        </Text>
        <Label size="s">{tpl.fileExt.toUpperCase()}</Label>
        <Text color="secondary">{t('editor:page.version', { version: tpl.version })}</Text>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <ExportTemplatesButton ids={[tpl.id]} />
          <Button view="outlined" href={templateDownloadUrl(tpl.id)}>
            <Icon data={ArrowDownToLine} />
            {t('editor:page.downloadFile')}
          </Button>
        </div>
      </div>
      {tpl.lastSaveError && (
        <div style={{ marginBottom: 12 }}>
          <Alert
            theme="danger"
            title={t('editor:page.lastSaveFailed')}
            message={tpl.lastSaveError}
          />
        </div>
      )}
      {warned && warned.total > 0 && (
        <div style={{ marginBottom: 12 }}>
          <Alert
            theme="warning"
            title={t('editor:page.cyrillicTitle')}
            message={
              <div>
                <div>{t('editor:page.cyrillicText')}</div>
                <ul style={{ margin: '8px 0 0', paddingLeft: 20 }}>
                  {warned.warnings.map((w) => (
                    <li key={w.tag}>
                      <code>{w.tag}</code> —{' '}
                      {w.word === w.letters[0] && w.letters.length === 1
                        ? t('editor:page.cyrillicStart', { word: w.word })
                        : t('editor:page.cyrillicLetters', {
                            word: w.word,
                            letters: w.letters.join(t('editor:page.cyrillicLettersSeparator')),
                          })}
                    </li>
                  ))}
                </ul>
                {warned.total > warned.warnings.length && (
                  <div>
                    {t('editor:page.andMore', { n: warned.total - warned.warnings.length })}
                  </div>
                )}
              </div>
            }
          />
        </div>
      )}
      <TabProvider value={tab} onUpdate={selectTab}>
        <TabList>
          {TABS.map((id) => (
            <Tab key={id} value={id}>
              {t(`editor:tab.${id}`)}
            </Tab>
          ))}
        </TabList>
      </TabProvider>
      <div style={{ marginTop: 16 }}>
        {/* Документ не размонтируется при переключении вкладок: сессия OnlyOffice не прерывается. */}
        {(documentVisited || tab === 'document') && (
          <div hidden={tab !== 'document'}>
            <DocumentTab {...tabProps} full={full} onFull={setFull} lock={lock} />
          </div>
        )}
        {tab === 'data' && <DataTab {...tabProps} />}
        {tab === 'charts' && <ChartsTab {...tabProps} />}
        {tab === 'pdf' && <PdfTab template={tpl} />}
        {tab === 'params' && <ParamsTab template={tpl} />}
        {tab === 'preview' && <PreviewTab {...tabProps} />}
        {tab === 'settings' && (
          <SettingsTab template={tpl} holder={documentVisited ? lock.holder : undefined} />
        )}
      </div>
    </>
  );
}
