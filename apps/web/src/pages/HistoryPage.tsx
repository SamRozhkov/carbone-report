import type { ParamsInput, RunDto } from '@carbone-reports/shared';
import { RUNS_PAGE_SIZE } from '@carbone-reports/shared';
import { ArrowDownToLine } from '@gravity-ui/icons';
import type { TableColumnConfig } from '@gravity-ui/uikit';
import { Button, Icon, Label, Loader, Pagination, Select, Table, Text } from '@gravity-ui/uikit';
import { useEffect } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { api, runFileUrl } from '../api/endpoints';
import { useMe } from '../api/session';
import { ErrorAlert } from '../components/ErrorAlert';
import { PageHeader } from '../components/PageHeader';
import { formatDateTime, formatDuration } from '../lib/format';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function formatRunParams(params: ParamsInput): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => `${k}: ${v === true ? 'да' : v === false ? 'нет' : String(v)}`);
  return parts.length ? parts.join(', ') : '—';
}

export function HistoryPage() {
  const me = useMe().data;
  const isAdmin = me?.role === 'admin';
  const [sp, setSp] = useSearchParams();
  const page = Math.min(10000, Math.max(1, Math.floor(Number(sp.get('page'))) || 1));
  const rawStatus = sp.get('status');
  const status = rawStatus === 'ok' || rawStatus === 'error' ? rawStatus : '';
  const rawTemplateId = sp.get('templateId') ?? '';
  const templateId = UUID_RE.test(rawTemplateId) ? rawTemplateId : '';
  const rawUserId = sp.get('userId') ?? '';
  const userId = isAdmin && UUID_RE.test(rawUserId) ? rawUserId : '';

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
    { id: 'createdAt', name: 'Дата', template: (r) => formatDateTime(r.createdAt), width: 150 },
    { id: 'template', name: 'Отчёт', template: (r) => r.templateName ?? '—' },
    ...(isAdmin
      ? [{ id: 'user', name: 'Пользователь', template: (r: RunDto) => r.userLogin }]
      : []),
    {
      id: 'params',
      name: 'Параметры',
      template: (r) => {
        const text = formatRunParams(r.params);
        return (
          <Text ellipsis title={text} style={{ maxWidth: 280, display: 'inline-block' }}>
            {text}
          </Text>
        );
      },
    },
    { id: 'format', name: 'Формат', template: (r) => r.outputFormat.toUpperCase(), width: 80 },
    {
      id: 'status',
      name: 'Результат',
      template: (r) =>
        r.status === 'ok' ? (
          <Label theme="success">готово</Label>
        ) : (
          <div>
            <Label theme="danger">ошибка</Label>
            <Text as="div" variant="caption-2" color="danger">
              {r.error}
            </Text>
          </div>
        ),
    },
    {
      id: 'duration',
      name: 'Время',
      template: (r) => formatDuration(r.durationMs),
      align: 'end',
      width: 100,
    },
    {
      id: 'file',
      name: '',
      width: 60,
      template: (r) =>
        r.fileAvailable ? (
          <Button view="flat" size="s" href={runFileUrl(r.id)} aria-label="Скачать" title="Скачать">
            <Icon data={ArrowDownToLine} />
          </Button>
        ) : r.status === 'ok' ? (
          <Text variant="caption-2" color="secondary">
            файл удалён
          </Text>
        ) : null,
    },
  ];

  return (
    <>
      <PageHeader title="История" />
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
        <Select
          placeholder="Все отчёты"
          aria-label="Отчёт"
          value={templateId ? [templateId] : []}
          onUpdate={([v]) => setFilter('templateId', v)}
          options={(templates.data ?? []).map((t) => ({ value: t.id, content: t.name }))}
          filterable
          hasClear
          width={240}
        />
        <Select
          placeholder="Любой результат"
          aria-label="Результат"
          value={status ? [status] : []}
          onUpdate={([v]) => setFilter('status', v)}
          options={[
            { value: 'ok', content: 'Готово' },
            { value: 'error', content: 'Ошибка' },
          ]}
          hasClear
          width={180}
        />
        {isAdmin && (
          <Select
            placeholder="Все пользователи"
            aria-label="Пользователь"
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
      {runs.isError ? null : runs.isPending ? (
        <Loader />
      ) : (
        <div style={isStale ? { opacity: 0.5 } : undefined}>
          <Table
            data={runs.data?.items ?? []}
            columns={columns}
            getRowDescriptor={(r) => ({ id: r.id })}
            emptyMessage={filtersActive ? 'Ничего не найдено' : 'Запусков пока нет'}
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
