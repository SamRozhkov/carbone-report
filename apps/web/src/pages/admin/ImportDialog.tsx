import type { DatasourceOption } from '@carbone-reports/shared';
import {
  MAX_TRANSFER_ARCHIVE_BYTES,
  type ImportAction,
  type ImportDecision,
  type ImportPreview,
  type ImportPreviewItem,
  type ImportResult,
} from '@carbone-reports/shared/template-transfer';
import type { TableColumnConfig } from '@gravity-ui/uikit';
import { Alert, Button, Dialog, Loader, Select, Table, Text } from '@gravity-ui/uikit';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/endpoints';
import { ApiRequestError } from '../../api/client';
import { errorMessage } from '../../api/errors';
import { i18n } from '../../i18n';
import { formatDateTime, formatTenths } from '../../lib/format';

const actionLabel = (a: ImportAction) => i18n.t(`templates:importAction.${a}`);

/** Выбор по строке предпросмотра. */
interface Row {
  action: ImportAction;
  datasourceId: string;
  targetId: string;
  /** После повторного предпросмотра: что изменилось в строке (строка выделяется). */
  note?: string;
}

/** Выбор по умолчанию: нет совпадения — «создать», есть — «обновить» самого свежего; ошибки — только «пропустить». */
function defaultRow(t: ImportPreviewItem): Row {
  const action: ImportAction =
    t.errors.length > 0 ? 'skip' : t.existing.length > 0 ? 'update' : 'create';
  return {
    action,
    datasourceId: t.datasourceMatch ?? '',
    targetId: t.existing[0]?.id ?? '',
  };
}

function actionsFor(t: ImportPreviewItem): ImportAction[] {
  if (t.errors.length > 0) return ['skip'];
  return t.existing.length > 0 ? ['update', 'copy', 'skip'] : ['create', 'skip'];
}

/**
 * Повторный предпросмотр (после 409): выбор администратора по строке сохраняется, пока он
 * допустим в новом плане; иначе — выбор по умолчанию, а строка помечается.
 */
function mergeRow(
  t: ImportPreviewItem,
  prev: { item: ImportPreviewItem; row: Row } | undefined,
  datasourceIds: Set<string> | null,
): Row {
  const d = defaultRow(t);
  if (!prev || prev.item.name !== t.name) return d;
  const p = prev.row;
  if (!actionsFor(t).includes(p.action)) {
    return {
      ...d,
      note: i18n.t('templates:import.noteUnavailable', {
        was: actionLabel(p.action),
        now: actionLabel(d.action),
      }),
    };
  }
  const notes: string[] = [];
  let targetId = d.targetId;
  if (p.action === 'update') {
    const now = t.existing.find((e) => e.id === p.targetId);
    if (!now) {
      return {
        ...d,
        note: i18n.t('templates:import.noteTargetGone'),
      };
    }
    targetId = p.targetId;
    const before = prev.item.existing.find((e) => e.id === p.targetId);
    if (before && before.updatedAt !== now.updatedAt)
      notes.push(i18n.t('templates:import.noteTargetChanged'));
  }
  let datasourceId = p.datasourceId;
  if (datasourceId && datasourceIds && !datasourceIds.has(datasourceId)) {
    datasourceId = d.datasourceId;
    notes.push(i18n.t('templates:import.noteDatasourceGone'));
  }
  const note =
    notes.length > 1
      ? i18n.t('templates:import.notesTwo', { first: notes[0], second: notes[1] })
      : notes[0];
  return { action: p.action, datasourceId, targetId, note };
}

function rowReady(r: Row): boolean {
  if (r.action === 'skip') return true;
  if (!r.datasourceId) return false;
  return r.action !== 'update' || !!r.targetId;
}

function toDecision(t: ImportPreviewItem, r: Row): ImportDecision {
  const index = t.index;
  if (r.action === 'skip') return { index, action: 'skip' };
  if (r.action !== 'update') return { index, action: r.action, datasourceId: r.datasourceId };
  // Время изменения цели из предпросмотра: изменённый после него шаблон API не обновит (409).
  const targetUpdatedAt = t.existing.find((e) => e.id === r.targetId)?.updatedAt ?? '';
  return {
    index,
    action: 'update',
    datasourceId: r.datasourceId,
    targetId: r.targetId,
    targetUpdatedAt,
  };
}

function messageOf(e: unknown): string {
  if (e instanceof ApiRequestError && e.status === 413) return i18n.t('templates:import.tooBig');
  return errorMessage(e);
}

/** Загрузка шаблонов из архива (§33.3): файл → предпросмотр → решения по строкам → итог. */
export function ImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  // `t` — строка предпросмотра, поэтому функция перевода — `tr`.
  const { t: tr } = useTranslation();
  const queryClient = useQueryClient();
  const datasources = useQuery({
    queryKey: ['datasources', 'options'],
    queryFn: api.datasources.options,
    enabled: open,
  });
  const [file, setFile] = useState<File | null>(null);
  const [sizeError, setSizeError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [result, setResult] = useState<ImportResult | null>(null);

  const previewM = useMutation({
    mutationFn: async (v: { f: File; prev?: { preview: ImportPreview; rows: Row[] } }) => {
      const form = new FormData();
      form.append('file', v.f);
      // Повтор: список источников тоже мог измениться.
      const [p] = await Promise.all([
        api.templates.importPreview(form),
        v.prev ? datasources.refetch() : null,
      ]);
      return p;
    },
    onSuccess: (p, v) => {
      setPreview(p);
      if (!v.prev) {
        setRows(p.templates.map(defaultRow));
        return;
      }
      const prev = v.prev;
      const byIndex = new Map(
        prev.preview.templates.map((item, i) => [item.index, { item, row: prev.rows[i]! }]),
      );
      const list = queryClient.getQueryData<DatasourceOption[]>(['datasources', 'options']);
      const ids = list ? new Set(list.map((d) => d.id)) : null;
      setRows(p.templates.map((t) => mergeRow(t, byIndex.get(t.index), ids)));
    },
  });
  const apply = useMutation({
    mutationFn: () => {
      const form = new FormData();
      form.append('file', file!);
      form.append(
        'decisions',
        JSON.stringify(rows.map((r, i) => toDecision(preview!.templates[i]!, r))),
      );
      return api.templates.importApply(form);
    },
    onSuccess: async (r) => {
      setResult(r);
      await queryClient.invalidateQueries({ queryKey: ['templates'] });
    },
  });
  const busy = previewM.isPending || apply.isPending;

  function reset() {
    setFile(null);
    setSizeError(null);
    setPreview(null);
    setRows([]);
    setResult(null);
    previewM.reset();
    apply.reset();
  }
  function close() {
    reset();
    onClose();
  }
  function choose(f: File | null) {
    reset();
    if (!f) return;
    if (f.size > MAX_TRANSFER_ARCHIVE_BYTES) {
      setSizeError(
        tr('templates:import.tooBigFile', {
          name: f.name,
          size: formatTenths(f.size / 1024 / 1024),
        }),
      );
      return;
    }
    setFile(f);
    previewM.mutate({ f });
  }
  /** После 409: тот же файл, выбор по строкам сохраняется, где он ещё допустим. */
  function retry() {
    if (!file || !preview) return;
    const prev = { preview, rows };
    apply.reset();
    previewM.mutate({ f: file, prev });
  }
  function patch(i: number, p: Partial<Row>) {
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...p } : r)));
  }

  const dsOptions = (datasources.data ?? []).map((d: DatasourceOption) => ({
    value: d.id,
    content: d.name,
  }));
  const ready =
    preview !== null &&
    rows.length === preview.templates.length &&
    rows.some((r) => r.action !== 'skip') &&
    rows.every(rowReady);
  // 409: данные изменились после предпросмотра — предлагаем повторить его.
  const conflict =
    apply.error instanceof ApiRequestError && apply.error.status === 409 && file !== null;

  const columns: TableColumnConfig<ImportPreviewItem>[] = [
    {
      id: 'name',
      name: tr('templates:import.template'),
      template: (t, i) => (
        <div data-changed={rows[i]?.note ? 'true' : undefined}>
          <Text>{t.name}</Text>
          <Text as="div" variant="caption-2" color="secondary">
            .{t.fileExt}
          </Text>
          {rows[i]?.note && (
            <Text as="div" variant="caption-2" color="warning">
              {rows[i]!.note}
            </Text>
          )}
          {t.errors.map((e, k) => (
            <Text key={k} as="div" variant="caption-2" color="danger">
              {e}
            </Text>
          ))}
          {t.missingGroups.length > 0 && (
            <Text as="div" variant="caption-2" color="warning">
              {tr('templates:import.missingGroups', { groups: t.missingGroups.join(', ') })}
            </Text>
          )}
          {t.pdfPasswordSet && (
            <Text as="div" variant="caption-2" color="warning">
              {tr('templates:import.pdfPassword')}
            </Text>
          )}
          {rows[i]?.action === 'update' &&
            (() => {
              const target = t.existing.find((e) => e.id === rows[i]!.targetId);
              return target?.lockedBy ? (
                <Text as="div" variant="caption-2" color="warning">
                  {tr('templates:import.lockedBy', { login: target.lockedBy.login })}
                </Text>
              ) : null;
            })()}
          {!t.categoryExists &&
            t.category &&
            (t.categorySkipped ? (
              <Text as="div" variant="caption-2" color="warning">
                {tr('templates:import.categorySkipped', { category: t.category })}
              </Text>
            ) : (
              <Text as="div" variant="caption-2" color="warning">
                {tr('templates:import.categoryCreated', { category: t.category })}
              </Text>
            ))}
        </div>
      ),
    },
    {
      id: 'action',
      name: tr('templates:import.action'),
      width: 220,
      template: (t, i) => {
        const r = rows[i];
        if (!r) return null;
        return (
          <div style={{ display: 'grid', gap: 4 }}>
            <Select
              aria-label={tr('templates:import.actionAria', { name: t.name })}
              value={[r.action]}
              disabled={busy}
              onUpdate={([v]) => v && patch(i, { action: v as ImportAction, note: undefined })}
              options={actionsFor(t).map((a) => ({ value: a, content: actionLabel(a) }))}
              width="max"
            />
            {r.action === 'update' &&
              (t.existing.length > 1 ? (
                <Select
                  aria-label={tr('templates:import.targetAria', { name: t.name })}
                  value={r.targetId ? [r.targetId] : []}
                  disabled={busy}
                  onUpdate={([v]) => patch(i, { targetId: v ?? '', note: undefined })}
                  options={t.existing.map((e) => ({
                    value: e.id,
                    content: `${e.name} · ${formatDateTime(e.updatedAt)}`,
                  }))}
                  width="max"
                />
              ) : (
                <Text variant="caption-2" color="secondary">
                  {tr('templates:import.targetUpdatedAt', {
                    date: formatDateTime(t.existing[0]!.updatedAt),
                  })}
                </Text>
              ))}
            {r.action === 'update' && (
              <Text variant="caption-2" color="secondary">
                {tr('templates:import.updateNote')}
              </Text>
            )}
          </div>
        );
      },
    },
    {
      id: 'datasource',
      name: tr('templates:import.datasource'),
      width: 240,
      template: (t, i) => {
        const r = rows[i];
        if (!r) return null;
        if (r.action === 'skip') return <Text color="secondary">—</Text>;
        return (
          <div style={{ display: 'grid', gap: 4 }}>
            <Select
              aria-label={tr('templates:import.datasourceAria', { name: t.name })}
              placeholder={tr('templates:import.chooseDatasource')}
              validationState={r.datasourceId ? undefined : 'invalid'}
              value={r.datasourceId ? [r.datasourceId] : []}
              disabled={busy || datasources.isLoading}
              onUpdate={([v]) => patch(i, { datasourceId: v ?? '' })}
              options={dsOptions}
              width="max"
            />
            {!t.datasourceMatch && (
              <Text variant="caption-2" color="secondary">
                {tr(
                  t.datasource.host
                    ? 'templates:import.inArchiveHost'
                    : 'templates:import.inArchive',
                  {
                    name: t.datasource.name,
                    host: t.datasource.host,
                    problem:
                      (datasources.data ?? []).filter((d) => d.name === t.datasource.name).length >
                      1
                        ? tr('templates:import.datasourceAmbiguous')
                        : tr('templates:import.datasourceNotFound'),
                  },
                )}
              </Text>
            )}
          </div>
        );
      },
    },
  ];

  return (
    <Dialog
      open={open}
      onClose={busy ? () => {} : close}
      aria-labelledby="cr-import-title"
      size="l"
    >
      <Dialog.Header caption={tr('templates:import.title')} id="cr-import-title" />
      <Dialog.Body>
        <div className="cr-form">
          {result ? (
            <Table
              data={result.templates}
              columns={[
                { id: 'name', name: tr('templates:import.template'), template: (r) => r.name },
                {
                  id: 'action',
                  name: tr('templates:import.result'),
                  template: (r) => tr(`templates:importResult.${r.action}`),
                },
              ]}
              getRowDescriptor={(r) => ({ id: String(r.index) })}
              width="max"
            />
          ) : (
            <>
              <input
                type="file"
                aria-label={tr('templates:import.fileAria')}
                accept=".zip,.crt.zip"
                disabled={busy}
                onChange={(e) => choose(e.target.files?.[0] ?? null)}
              />
              {sizeError && <Alert theme="danger" message={sizeError} />}
              {previewM.isPending && <Loader />}
              {datasources.error && (
                <Alert
                  theme="danger"
                  title={tr('templates:import.datasourcesFailed')}
                  message={errorMessage(datasources.error)}
                />
              )}
              {previewM.error && (
                <Alert
                  theme="danger"
                  title={tr('templates:import.rejected')}
                  message={messageOf(previewM.error)}
                />
              )}
              {preview && (
                <>
                  <Text variant="caption-2" color="secondary">
                    {tr('templates:import.archiveInfo', {
                      version: preview.appVersion,
                      date: formatDateTime(preview.exportedAt),
                    })}
                  </Text>
                  <Table
                    data={preview.templates}
                    columns={columns}
                    getRowDescriptor={(t) => ({ id: String(t.index) })}
                    width="max"
                  />
                </>
              )}
              {apply.error && (
                <Alert
                  theme="danger"
                  title={tr('templates:import.applyFailed')}
                  message={messageOf(apply.error)}
                  actions={
                    conflict ? (
                      <Button view="outlined" onClick={retry}>
                        {tr('templates:import.retry')}
                      </Button>
                    ) : undefined
                  }
                />
              )}
            </>
          )}
        </div>
      </Dialog.Body>
      {result ? (
        <Dialog.Footer onClickButtonCancel={close} textButtonCancel={tr('common:action.close')} />
      ) : (
        <Dialog.Footer
          onClickButtonApply={() => apply.mutate()}
          onClickButtonCancel={busy ? () => {} : close}
          textButtonApply={tr('templates:import.apply')}
          textButtonCancel={tr('common:action.cancel')}
          loading={apply.isPending}
          propsButtonApply={{ disabled: !ready || previewM.isPending }}
        />
      )}
    </Dialog>
  );
}
