import type { DatasourceDto } from '@carbone-reports/shared';
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
import { api } from '../../api/endpoints';
import { ApiRequestError } from '../../api/client';
import { errorMessage } from '../../api/errors';
import { formatDateTime } from '../../lib/format';

const ACTION_LABELS: Record<ImportAction, string> = {
  create: 'создать',
  update: 'обновить',
  copy: 'копия',
  skip: 'пропустить',
};
const RESULT_LABELS: Record<ImportAction, string> = {
  create: 'создан',
  update: 'обновлён',
  copy: 'создана копия',
  skip: 'пропущен',
};
const TOO_BIG = 'Архив больше 50 МБ — такой файл загрузить нельзя.';

/** Выбор по строке предпросмотра. */
interface Row {
  action: ImportAction;
  datasourceId: string;
  targetId: string;
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

function rowReady(r: Row): boolean {
  if (r.action === 'skip') return true;
  if (!r.datasourceId) return false;
  return r.action !== 'update' || !!r.targetId;
}

function toDecision(index: number, r: Row): ImportDecision {
  if (r.action === 'skip') return { index, action: 'skip' };
  return {
    index,
    action: r.action,
    datasourceId: r.datasourceId,
    ...(r.action === 'update' ? { targetId: r.targetId } : {}),
  };
}

function messageOf(e: unknown): string {
  if (e instanceof ApiRequestError && e.status === 413) return TOO_BIG;
  return errorMessage(e);
}

/** Загрузка шаблонов из архива (§33.3): файл → предпросмотр → решения по строкам → итог. */
export function ImportDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const datasources = useQuery({
    queryKey: ['datasources'],
    queryFn: api.datasources.list,
    enabled: open,
  });
  const [file, setFile] = useState<File | null>(null);
  const [sizeError, setSizeError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [result, setResult] = useState<ImportResult | null>(null);

  const previewM = useMutation({
    mutationFn: (f: File) => {
      const form = new FormData();
      form.append('file', f);
      return api.templates.importPreview(form);
    },
    onSuccess: (p) => {
      setPreview(p);
      setRows(p.templates.map(defaultRow));
    },
  });
  const apply = useMutation({
    mutationFn: () => {
      const form = new FormData();
      form.append('file', file!);
      form.append(
        'decisions',
        JSON.stringify(rows.map((r, i) => toDecision(preview!.templates[i]!.index, r))),
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
      setSizeError(`${TOO_BIG} Размер файла «${f.name}»: ${(f.size / 1024 / 1024).toFixed(1)} МБ.`);
      return;
    }
    setFile(f);
    previewM.mutate(f);
  }
  function patch(i: number, p: Partial<Row>) {
    setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...p } : r)));
  }

  const dsOptions = (datasources.data ?? []).map((d: DatasourceDto) => ({
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
      name: 'Шаблон',
      template: (t) => (
        <div>
          <Text>{t.name}</Text>
          <Text as="div" variant="caption-2" color="secondary">
            .{t.fileExt}
          </Text>
          {t.errors.map((e) => (
            <Text key={e} as="div" variant="caption-2" color="danger">
              {e}
            </Text>
          ))}
          {t.missingGroups.length > 0 && (
            <Text as="div" variant="caption-2" color="warning">
              Нет групп: {t.missingGroups.join(', ')} — доступ не будет выдан
            </Text>
          )}
          {!t.categoryExists && t.category && (
            <Text as="div" variant="caption-2" color="warning">
              Будет создана категория «{t.category}»
            </Text>
          )}
        </div>
      ),
    },
    {
      id: 'action',
      name: 'Действие',
      width: 220,
      template: (t, i) => {
        const r = rows[i];
        if (!r) return null;
        return (
          <div style={{ display: 'grid', gap: 4 }}>
            <Select
              aria-label={`Действие: ${t.name}`}
              value={[r.action]}
              onUpdate={([v]) => v && patch(i, { action: v as ImportAction })}
              options={actionsFor(t).map((a) => ({ value: a, content: ACTION_LABELS[a] }))}
              width="max"
            />
            {r.action === 'update' &&
              (t.existing.length > 1 ? (
                <Select
                  aria-label={`Какой шаблон обновить: ${t.name}`}
                  value={r.targetId ? [r.targetId] : []}
                  onUpdate={([v]) => patch(i, { targetId: v ?? '' })}
                  options={t.existing.map((e) => ({
                    value: e.id,
                    content: `${e.name} · ${formatDateTime(e.updatedAt)}`,
                  }))}
                  width="max"
                />
              ) : (
                <Text variant="caption-2" color="secondary">
                  изменён {formatDateTime(t.existing[0]!.updatedAt)}
                </Text>
              ))}
          </div>
        );
      },
    },
    {
      id: 'datasource',
      name: 'Источник данных',
      width: 240,
      template: (t, i) => {
        const r = rows[i];
        if (!r) return null;
        if (r.action === 'skip') return <Text color="secondary">—</Text>;
        return (
          <div style={{ display: 'grid', gap: 4 }}>
            <Select
              aria-label={`Источник данных: ${t.name}`}
              placeholder="Выберите источник"
              validationState={r.datasourceId ? undefined : 'invalid'}
              value={r.datasourceId ? [r.datasourceId] : []}
              onUpdate={([v]) => patch(i, { datasourceId: v ?? '' })}
              options={dsOptions}
              width="max"
            />
            {!t.datasourceMatch && (
              <Text variant="caption-2" color="secondary">
                В архиве: «{t.datasource.name}» ({t.datasource.host}) —{' '}
                {(datasources.data ?? []).filter((d) => d.name === t.datasource.name).length > 1
                  ? 'найдено несколько источников с этим именем — выберите'
                  : 'в этой среде не найден'}
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
      <Dialog.Header caption="Загрузка шаблонов из архива" id="cr-import-title" />
      <Dialog.Body>
        <div className="cr-form">
          {result ? (
            <Table
              data={result.templates}
              columns={[
                { id: 'name', name: 'Шаблон', template: (r) => r.name },
                { id: 'action', name: 'Итог', template: (r) => RESULT_LABELS[r.action] },
              ]}
              getRowDescriptor={(r) => ({ id: String(r.index) })}
              width="max"
            />
          ) : (
            <>
              <input
                type="file"
                aria-label="Файл архива"
                accept=".zip,.crt.zip"
                disabled={busy}
                onChange={(e) => choose(e.target.files?.[0] ?? null)}
              />
              {sizeError && <Alert theme="danger" message={sizeError} />}
              {previewM.isPending && <Loader />}
              {previewM.error && (
                <Alert theme="danger" title="Архив не принят" message={messageOf(previewM.error)} />
              )}
              {preview && (
                <>
                  <Text variant="caption-2" color="secondary">
                    Версия приложения в архиве: {preview.appVersion}, выгружено{' '}
                    {formatDateTime(preview.exportedAt)}
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
                  title="Не удалось загрузить"
                  message={messageOf(apply.error)}
                  actions={
                    conflict ? (
                      <Button view="outlined" onClick={() => choose(file)}>
                        Повторить предпросмотр
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
        <Dialog.Footer onClickButtonCancel={close} textButtonCancel="Закрыть" />
      ) : (
        <Dialog.Footer
          onClickButtonApply={() => apply.mutate()}
          onClickButtonCancel={busy ? () => {} : close}
          textButtonApply="Загрузить"
          textButtonCancel="Отмена"
          loading={apply.isPending}
          propsButtonApply={{ disabled: !ready || previewM.isPending }}
        />
      )}
    </Dialog>
  );
}
