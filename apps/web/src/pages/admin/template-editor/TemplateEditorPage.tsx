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
import { useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { api, templateDownloadUrl } from '../../../api/endpoints';
import { ErrorAlert } from '../../../components/ErrorAlert';
import { DataTab } from './DataTab';
import { DocumentTab } from './DocumentTab';
import { templateKey, usePreviewData, useTestParams } from './editorState';
import { ParamsTab } from './ParamsTab';
import { PreviewTab } from './PreviewTab';
import { SettingsTab } from './SettingsTab';

const TABS = ['document', 'data', 'params', 'preview', 'settings'] as const;
type TabId = (typeof TABS)[number];

export function TemplateEditorPage() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const [sp, setSp] = useSearchParams();
  const raw = sp.get('tab');
  const tab: TabId = (TABS as readonly string[]).includes(raw ?? '') ? (raw as TabId) : 'document';
  const [documentVisited, setDocumentVisited] = useState(tab === 'document');
  if (tab === 'document' && !documentVisited) setDocumentVisited(true);

  const template = useQuery({
    queryKey: templateKey(id),
    queryFn: () => api.templates.getAdmin(id),
  });
  const t = template.data;
  const [testParams, setTestParams] = useTestParams(id, t?.params ?? []);
  const [previewData, setPreviewData] = usePreviewData(id);

  if (template.isPending) return <Loader />;
  if (!t) return <ErrorAlert error={template.error} title="Не удалось открыть шаблон" />;

  const selectTab = (value: string) => {
    const next = new URLSearchParams(sp);
    next.set('tab', value);
    setSp(next, { replace: true });
  };
  const tabProps = {
    template: t,
    testParams,
    onTestParams: setTestParams,
    previewData,
    onPreviewData: setPreviewData,
  };

  return (
    <>
      <div className="cr-editor-head">
        <Button view="flat" onClick={() => navigate('/admin/templates')}>
          ← Шаблоны
        </Button>
        <Text variant="header-1" as="h1">
          {t.name}
        </Text>
        <Label size="s">{t.fileExt.toUpperCase()}</Label>
        <Text color="secondary">версия {t.version}</Text>
        <div style={{ marginLeft: 'auto' }}>
          <Button view="outlined" href={templateDownloadUrl(t.id)}>
            <Icon data={ArrowDownToLine} />
            Скачать файл
          </Button>
        </div>
      </div>
      {t.lastSaveError && (
        <div style={{ marginBottom: 12 }}>
          <Alert
            theme="danger"
            title="Последнее сохранение из редактора не удалось"
            message={t.lastSaveError}
          />
        </div>
      )}
      <TabProvider value={tab} onUpdate={selectTab}>
        <TabList>
          <Tab value="document">Документ</Tab>
          <Tab value="data">Данные</Tab>
          <Tab value="params">Параметры</Tab>
          <Tab value="preview">Предпросмотр</Tab>
          <Tab value="settings">Настройки</Tab>
        </TabList>
      </TabProvider>
      <div style={{ marginTop: 16 }}>
        {/* Документ не размонтируется при переключении вкладок: сессия OnlyOffice не прерывается. */}
        {(documentVisited || tab === 'document') && (
          <div hidden={tab !== 'document'}>
            <DocumentTab {...tabProps} />
          </div>
        )}
        {tab === 'data' && <DataTab {...tabProps} />}
        {tab === 'params' && <ParamsTab template={t} />}
        {tab === 'preview' && <PreviewTab {...tabProps} />}
        {tab === 'settings' && <SettingsTab template={t} />}
      </div>
    </>
  );
}
