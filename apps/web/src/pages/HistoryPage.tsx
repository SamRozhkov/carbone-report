import type { ParamsInput, RunDto, SignMethod } from '@carbone-reports/shared';
import { RUNS_PAGE_SIZE } from '@carbone-reports/shared';
import { ArrowDownToLine, PencilToLine } from '@gravity-ui/icons';
import type { TableColumnConfig } from '@gravity-ui/uikit';
import {
  Button,
  DropdownMenu,
  Icon,
  Label,
  Loader,
  Pagination,
  Select,
  Table,
  Text,
} from '@gravity-ui/uikit';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { api, runFileUrl } from '../api/endpoints';
import { useMe } from '../api/session';
import { useRunDownload } from '../api/useRunDownload';
import { ErrorAlert } from '../components/ErrorAlert';
import { SignGostDialog } from '../components/SignGostDialog';
import { SignRunDialog } from '../components/SignRunDialog';
import { PageHeader } from '../components/PageHeader';
import { i18n } from '../i18n';
import { formatDateTime, formatDuration } from '../lib/format';

const methodLabel = (m: SignMethod) => (m === 'gost' ? i18n.t('history:methodGost') : '.p12');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function runParamValue(v: Exclude<ParamsInput[string], null | undefined>): string {
  if (v === true) return i18n.t('history:params.yes');
  if (v === false) return i18n.t('history:params.no');
  if (Array.isArray(v)) return i18n.t('history:params.list', { values: v.join(', ') });
  return String(v);
}

export function formatRunParams(params: ParamsInput): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => i18n.t('history:params.item', { name: k, value: runParamValue(v!) }));
  return parts.length ? parts.join(', ') : '—';
}

export function HistoryPage() {
  const me = useMe().data;
  const isAdmin = me?.role === 'admin';
  const { t } = useTranslation();
  const [sp, setSp] = useSearchParams();
  const page = Math.min(10000, Math.max(1, Math.floor(Number(sp.get('page'))) || 1));
  const rawStatus = sp.get('status');
  const status = rawStatus === 'ok' || rawStatus === 'error' ? rawStatus : '';
  const rawTemplateId = sp.get('templateId') ?? '';
  const templateId = UUID_RE.test(rawTemplateId) ? rawTemplateId : '';
  const rawUserId = sp.get('userId') ?? '';
  const userId = isAdmin && UUID_RE.test(rawUserId) ? rawUserId : '';

  const download = useRunDownload();
  const queryClient = useQueryClient();
  const [signing, setSigning] = useState<{ id: string; method: SignMethod | null } | null>(null);
  const runs = useQuery({
    queryKey: ['runs', { page, status, templateId, userId }],
    queryFn: () =>
      api.runs.list({
        page,
        status: status || undefined,
        templateId: templateId || undefined,
        userId: userId || undefined,
      }),
    placeholderData: keepPreviousData,
  });
  const templates = useQuery({ queryKey: ['templates'], queryFn: api.templates.list });
  const users = useQuery({ queryKey: ['users'], queryFn: api.users.list, enabled: isAdmin });

  const total = runs.data?.total ?? 0;
  const itemCount = runs.data?.items.length ?? 0;
  const isStale = runs.isPlaceholderData;
  useEffect(() => {
    if (isStale || itemCount !== 0 || total <= 0 || page <= 1) return;
    const last = Math.ceil(total / RUNS_PAGE_SIZE);
    if (page <= last) return;
    const next = new URLSearchParams(sp);
    if (last > 1) next.set('page', String(last));
    else next.delete('page');
    setSp(next, { replace: true });
  }, [isStale, itemCount, total, page, sp, setSp]);
  const filtersActive = Boolean(status || templateId || userId);

  const setFilter = (key: string, value: string | undefined) => {
    const next = new URLSearchParams(sp);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== 'page') next.delete('page');
    setSp(next);
  };

  const columns: TableColumnConfig<RunDto>[] = [
    {
      id: 'createdAt',
      name: t('history:column.date'),
      template: (r) => formatDateTime(r.createdAt),
      width: 150,
    },
    { id: 'template', name: t('history:column.report'), template: (r) => r.templateName ?? '—' },
    ...(isAdmin
      ? [{ id: 'user', name: t('history:column.user'), template: (r: RunDto) => r.userLogin }]
      : []),
    {
      id: 'params',
      name: t('history:column.params'),
      template: (r) => {
        const text = formatRunParams(r.params);
        return (
          <Text ellipsis title={text} style={{ maxWidth: 280, display: 'inline-block' }}>
            {text}
          </Text>
        );
      },
    },
    {
      id: 'format',
      name: t('history:column.format'),
      // Старый запуск — его формат; запуск со снимком — уже собранные форматы.
      template: (r) =>
        (r.outputFormat ? [r.outputFormat] : r.readyFormats)
          .map((f) => f.toUpperCase())
          .join(', ') || '—',
      width: 110,
    },
    {
      id: 'status',
      name: t('history:column.result'),
      template: (r) =>
        r.status === 'ok' ? (
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <Label theme="success">{t('history:status.ok')}</Label>
            {r.signature && (
              <span
                title={t('history:signed', {
                  method: methodLabel(r.signature.method),
                  signer: r.signature.signerCn,
                  date: formatDateTime(r.signature.signedAt),
                })}
              >
                <Icon data={PencilToLine} size={16} />
              </span>
            )}
          </span>
        ) : (
          <div>
            <Label theme="danger">{t('history:status.error')}</Label>
            <Text as="div" variant="caption-2" color="danger">
              {r.error}
            </Text>
          </div>
        ),
    },
    {
      id: 'duration',
      name: t('history:column.duration'),
      template: (r) => formatDuration(r.durationMs),
      align: 'end',
      width: 100,
    },
    {
      id: 'file',
      name: '',
      width: 60,
      template: (r) => {
        if (!r.fileAvailable) {
          return r.status === 'ok' ? (
            <Text variant="caption-2" color="secondary">
              {t('history:file.deleted')}
            </Text>
          ) : null;
        }
        // Старый запуск — одна ссылка, как раньше.
        if (r.outputFormat) {
          return (
            <Button
              view="flat"
              size="s"
              href={runFileUrl(r.id)}
              aria-label={t('history:file.download')}
              title={t('history:file.download')}
            >
              <Icon data={ArrowDownToLine} />
            </Button>
          );
        }
        // Запуск со снимком — меню со всеми форматами (§24.6).
        return (
          <DropdownMenu
            items={[
              ...r.formats.map((f) => ({
                text: f.toUpperCase(),
                action: () => download.save({ runId: r.id, format: f }),
              })),
              ...(r.signature?.method === 'gost'
                ? [
                    {
                      text: t('history:file.stampedPdf'),
                      action: () => download.save({ runId: r.id, format: 'pdf', signed: true }),
                    },
                    {
                      text: t('history:file.sig'),
                      action: () => download.save({ runId: r.id, format: 'sig' }),
                    },
                  ]
                : r.signature
                  ? [
                      {
                        text: t('history:file.signedPdf'),
                        action: () => download.save({ runId: r.id, format: 'pdf', signed: true }),
                      },
                    ]
                  : []),
              ...(r.signable
                ? [
                    {
                      text: t('history:file.sign'),
                      action: () => setSigning({ id: r.id, method: r.signMethod }),
                    },
                  ]
                : []),
            ]}
            renderSwitcher={({ onClick, onKeyDown }) => (
              <Button
                view="flat"
                size="s"
                aria-label={t('history:file.download')}
                title={t('history:file.download')}
                loading={download.pending?.runId === r.id}
                onClick={onClick}
                extraProps={{ onKeyDown }}
              >
                <Icon data={ArrowDownToLine} />
              </Button>
            )}
          />
        );
      },
    },
  ];

  // Способ подписи — из снимка запуска (§42.1).
  const SignDialog = signing?.method === 'gost' ? SignGostDialog : SignRunDialog;

  return (
    <>
      <PageHeader title={t('history:title')} />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        <Select
          placeholder={t('history:filter.allReports')}
          aria-label={t('history:column.report')}
          value={templateId ? [templateId] : []}
          onUpdate={([v]) => setFilter('templateId', v)}
          options={(templates.data ?? []).map((t) => ({ value: t.id, content: t.name }))}
          filterable
          hasClear
          width={240}
        />
        <Select
          placeholder={t('history:filter.anyResult')}
          aria-label={t('history:column.result')}
          value={status ? [status] : []}
          onUpdate={([v]) => setFilter('status', v)}
          options={[
            { value: 'ok', content: t('history:filter.ok') },
            { value: 'error', content: t('history:filter.error') },
          ]}
          hasClear
          width={180}
        />
        {isAdmin && (
          <Select
            placeholder={t('history:filter.allUsers')}
            aria-label={t('history:column.user')}
            value={userId ? [userId] : []}
            onUpdate={([v]) => setFilter('userId', v)}
            options={(users.data ?? []).map((u) => ({ value: u.id, content: u.login }))}
            filterable
            hasClear
            width={200}
          />
        )}
      </div>
      <ErrorAlert error={runs.error} />
      <ErrorAlert error={download.error} title={t('history:file.downloadFailed')} />
      {signing && (
        <SignDialog
          runId={signing.id}
          open
          onClose={() => setSigning(null)}
          onSigned={() => {
            setSigning(null);
            void queryClient.invalidateQueries({ queryKey: ['runs'] });
          }}
        />
      )}
      {runs.isError ? null : runs.isPending ? (
        <Loader />
      ) : (
        <div style={isStale ? { opacity: 0.5 } : undefined}>
          <Table
            data={runs.data?.items ?? []}
            columns={columns}
            getRowDescriptor={(r) => ({ id: r.id })}
            emptyMessage={filtersActive ? t('history:notFound') : t('history:empty')}
            width="max"
          />
          {total > RUNS_PAGE_SIZE && (
            <div style={{ marginTop: 16 }}>
              <Pagination
                page={page}
                pageSize={RUNS_PAGE_SIZE}
                total={total}
                onUpdate={(p) => setFilter('page', String(p))}
              />
            </div>
          )}
        </div>
      )}
    </>
  );
}
