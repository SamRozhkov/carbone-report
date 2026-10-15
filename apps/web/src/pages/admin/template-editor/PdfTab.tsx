import {
  hasPdfProtection,
  normalizePdfOptions,
  PDF_PAGE_FORMAT_DEFAULT,
  type PdfMetadata,
  type PdfOptions,
  type PdfPageNumbers,
  type PdfProtection,
  type PdfWatermark,
  type SavePdfOptionsBody,
  type TemplateAdminDetails,
  type TemplateAttachment,
} from '@carbone-reports/shared';
import { ArrowDown, ArrowUp, TrashBin } from '@gravity-ui/icons';
import {
  Button,
  Card,
  Checkbox,
  Icon,
  Label,
  Select,
  Text,
  TextInput,
  useToaster,
} from '@gravity-ui/uikit';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { api } from '../../../api/endpoints';
import { fieldErrors } from '../../../api/errors';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { ErrorAlert } from '../../../components/ErrorAlert';
import { Field } from '../../../components/Field';
import { GeneralError } from '../../../components/GeneralError';
import type { TabProps } from './editorState';
import { applyTemplate } from './editorState';

const OPACITY = [10, 20, 30, 40, 50].map((n) => ({ value: String(n), content: `${n} %` }));
const COLORS = [
  { value: 'gray', content: 'Серый' },
  { value: 'red', content: 'Красный' },
  { value: 'blue', content: 'Синий' },
];
const ANGLES = [
  { value: 'diagonal', content: 'По диагонали' },
  { value: 'horizontal', content: 'Горизонтально' },
];
const POSITIONS = [
  { value: 'bottom-center', content: 'Внизу по центру' },
  { value: 'bottom-right', content: 'Внизу справа' },
  { value: 'top-right', content: 'Вверху справа' },
];
const PLACEMENTS = [
  { value: 'end', content: 'В конец' },
  { value: 'start', content: 'В начало' },
];
const META: { key: keyof PdfMetadata; label: string }[] = [
  { key: 'title', label: 'Название' },
  { key: 'author', label: 'Автор' },
  { key: 'subject', label: 'Тема' },
  { key: 'keywords', label: 'Ключевые слова' },
];
const NO_PROTECTION: PdfProtection = { noPrint: false, noCopy: false, noModify: false };
const PROTECTION: { key: keyof PdfProtection; label: string }[] = [
  { key: 'noPrint', label: 'Запретить печать' },
  { key: 'noCopy', label: 'Запретить копирование текста' },
  { key: 'noModify', label: 'Запретить изменение' },
];
type PwState = { mode: 'keep' | 'set' | 'remove'; value: string };
const TAG_HINT = 'Можно {d.поле} — без форматтеров.';

/** Черновик хранит выключенные блоки, чтобы флажок не стирал введённый текст. */
interface Draft {
  pdfa: boolean;
  wmOn: boolean;
  wm: PdfWatermark;
  pnOn: boolean;
  pn: PdfPageNumbers;
  meta: PdfMetadata;
  prot: PdfProtection;
}

function toDraft(o: PdfOptions): Draft {
  return {
    pdfa: o.pdfa,
    wmOn: Boolean(o.watermark),
    wm: o.watermark ?? { text: '', opacity: 20, color: 'gray', angle: 'diagonal' },
    pnOn: Boolean(o.pageNumbers),
    pn: o.pageNumbers ?? {
      format: PDF_PAGE_FORMAT_DEFAULT,
      position: 'bottom-center',
      skipFirst: false,
    },
    meta: o.metadata ?? { title: '', author: '', subject: '', keywords: '' },
    prot: o.protection ?? NO_PROTECTION,
  };
}

function fromDraft(d: Draft): PdfOptions {
  return normalizePdfOptions({
    pdfa: d.pdfa,
    ...(d.wmOn ? { watermark: d.wm } : {}),
    ...(d.pnOn ? { pageNumbers: d.pn } : {}),
    metadata: d.meta,
    protection: d.prot,
  });
}

const canon = (o: PdfOptions) => JSON.stringify(fromDraft(toDraft(o)));
const kb = (n: number) => `${Math.max(1, Math.round(n / 1024))} КБ`;

export function PdfTab({ template }: Pick<TabProps, 'template'>) {
  const queryClient = useQueryClient();
  const { add } = useToaster();
  const fileRef = useRef<HTMLInputElement>(null);
  const [baseline, setBaseline] = useState(template.pdfOptions);
  const [draft, setDraft] = useState<Draft>(() => toDraft(template.pdfOptions));
  const [placement, setPlacement] = useState<'start' | 'end'>('end');
  const [removing, setRemoving] = useState<TemplateAttachment | null>(null);
  const [pw, setPw] = useState<PwState>(() => ({
    mode: template.pdfPasswordSet ? 'keep' : 'set',
    value: '',
  }));
  const [showPw, setShowPw] = useState(false);
  const pwBody: Pick<SavePdfOptionsBody, 'password'> =
    pw.mode === 'remove'
      ? { password: null }
      : pw.mode === 'set' && pw.value
        ? { password: pw.value }
        : {};
  const pwDirty = 'password' in pwBody;
  const passwordSet =
    pw.mode === 'remove'
      ? false
      : pw.mode === 'set' && pw.value !== ''
        ? true
        : template.pdfPasswordSet;
  const protectionOn = hasPdfProtection({ protection: draft.prot }, passwordSet);
  const dirty = JSON.stringify(fromDraft(draft)) !== canon(baseline) || pwDirty;
  // Настройки изменились на сервере: без несохранённых правок подхватываем, иначе — предупреждение.
  const stale = canon(template.pdfOptions) !== canon(baseline);
  const reseed = (t: TemplateAdminDetails) => {
    setBaseline(t.pdfOptions);
    setDraft(toDraft(t.pdfOptions));
  };
  if (stale && !dirty) reseed(template);

  const setPwState = (next: PwState) => {
    save.reset();
    setPw(next);
  };

  const save = useMutation({
    mutationFn: () => api.templates.savePdfOptions(template.id, { ...fromDraft(draft), ...pwBody }),
    onSuccess: (t) => {
      applyTemplate(queryClient, t);
      reseed(t);
      setPw({ mode: t.pdfPasswordSet ? 'keep' : 'set', value: '' });
      setShowPw(false);
      add({ name: `tpl-pdf-${Date.now()}`, title: 'Настройки PDF сохранены', theme: 'success' });
    },
  });
  const files = useMutation({
    mutationFn: (op: () => Promise<TemplateAdminDetails>) => op(),
    onSuccess: (t) => {
      applyTemplate(queryClient, t);
    },
    // Диалог закрываем и при ошибке — иначе ErrorAlert остаётся под ним.
    onSettled: () => setRemoving(null),
  });

  const errors = fieldErrors(save.error);
  const shown: string[] = [];
  const errorOf = (key: string) => {
    if (errors[key] !== undefined) shown.push(key);
    return errors[key];
  };
  const set = (patch: Partial<Draft>) => {
    save.reset();
    setDraft((d) => ({ ...d, ...patch }));
  };

  const upload = (file: File) => {
    const form = new FormData();
    form.append('placement', placement);
    form.append('file', file);
    files.mutate(() => api.templates.uploadAttachment(template.id, form));
  };
  const groups = {
    start: template.attachments.filter((a) => a.placement === 'start'),
    end: template.attachments.filter((a) => a.placement === 'end'),
  };

  return (
    <div className="cr-stack" style={{ maxWidth: 760 }}>
      <Card view="outlined" style={{ padding: 16 }} className="cr-stack">
        <Checkbox checked={draft.pdfa} disabled={protectionOn} onUpdate={(pdfa) => set({ pdfa })}>
          PDF/A-2b
        </Checkbox>
        <Text color="secondary">
          Формат для архива и электронного документооборота: шрифты встроены, документ не зависит от
          внешних ресурсов. Все приложенные файлы тоже должны быть в PDF/A.
        </Text>
        {protectionOn && <Text color="secondary">Недоступно при пароле или запретах</Text>}
        {errorOf('pdfa') && <Text color="danger">{errors.pdfa}</Text>}
      </Card>

      <Card view="outlined" style={{ padding: 16 }} className="cr-stack">
        <Checkbox checked={draft.wmOn} onUpdate={(wmOn) => set({ wmOn })}>
          Водяной знак
        </Checkbox>
        {draft.wmOn && (
          <>
            <Field label="Текст" hint={TAG_HINT} error={errorOf('watermark.text')}>
              <TextInput
                value={draft.wm.text}
                onUpdate={(text) => set({ wm: { ...draft.wm, text } })}
                controlProps={{ 'aria-label': 'Текст водяного знака', maxLength: 200 }}
              />
            </Field>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <Field label="Прозрачность">
                <Select
                  value={[String(draft.wm.opacity)]}
                  options={OPACITY}
                  onUpdate={([v]) => set({ wm: { ...draft.wm, opacity: Number(v) } })}
                />
              </Field>
              <Field label="Цвет">
                <Select
                  value={[draft.wm.color]}
                  options={COLORS}
                  onUpdate={([v]) =>
                    set({ wm: { ...draft.wm, color: v as PdfWatermark['color'] } })
                  }
                />
              </Field>
              <Field label="Направление">
                <Select
                  value={[draft.wm.angle]}
                  options={ANGLES}
                  onUpdate={([v]) =>
                    set({ wm: { ...draft.wm, angle: v as PdfWatermark['angle'] } })
                  }
                />
              </Field>
            </div>
          </>
        )}
      </Card>

      <Card view="outlined" style={{ padding: 16 }} className="cr-stack">
        <Checkbox checked={draft.pnOn} onUpdate={(pnOn) => set({ pnOn })}>
          Нумерация страниц
        </Checkbox>
        {draft.pnOn && (
          <>
            <Field
              label="Формат"
              hint="{page} — номер страницы, {pages} — всего страниц, считая приложенные файлы."
              error={errorOf('pageNumbers.format')}
            >
              <TextInput
                value={draft.pn.format}
                onUpdate={(format) => set({ pn: { ...draft.pn, format } })}
                controlProps={{ 'aria-label': 'Формат номера страницы', maxLength: 100 }}
              />
            </Field>
            <Field label="Положение">
              <Select
                value={[draft.pn.position]}
                options={POSITIONS}
                onUpdate={([v]) =>
                  set({ pn: { ...draft.pn, position: v as PdfPageNumbers['position'] } })
                }
              />
            </Field>
            <Checkbox
              checked={draft.pn.skipFirst}
              onUpdate={(skipFirst) => set({ pn: { ...draft.pn, skipFirst } })}
            >
              Не нумеровать первую страницу
            </Checkbox>
          </>
        )}
      </Card>

      <Card view="outlined" style={{ padding: 16 }} className="cr-stack">
        <Text variant="subheader-2">Метаданные</Text>
        <Text color="secondary">Пустое название — имя шаблона. {TAG_HINT}</Text>
        {META.map(({ key, label }) => (
          <Field key={key} label={label} error={errorOf(`metadata.${key}`)}>
            <TextInput
              value={draft.meta[key]}
              onUpdate={(v) => set({ meta: { ...draft.meta, [key]: v } })}
              controlProps={{ 'aria-label': `Метаданные: ${label}`, maxLength: 500 }}
            />
          </Field>
        ))}
      </Card>

      <Card view="outlined" style={{ padding: 16 }} className="cr-stack">
        <Text variant="subheader-2">Защита</Text>
        {draft.pdfa && <Text color="secondary">Недоступно при PDF/A</Text>}
        {pw.mode === 'keep' ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Text>Пароль задан</Text>
            <Button disabled={draft.pdfa} onClick={() => setPwState({ mode: 'set', value: '' })}>
              Сменить
            </Button>
            <Button disabled={draft.pdfa} onClick={() => setPwState({ mode: 'remove', value: '' })}>
              Убрать
            </Button>
          </div>
        ) : pw.mode === 'remove' ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Text>Пароль будет снят при сохранении</Text>
            <Button onClick={() => setPwState({ mode: 'keep', value: '' })}>Отмена</Button>
          </div>
        ) : (
          <Field label="Пароль на открытие" error={errorOf('password')}>
            <div style={{ display: 'flex', gap: 8 }}>
              <TextInput
                type={showPw ? 'text' : 'password'}
                value={pw.value}
                disabled={draft.pdfa}
                onUpdate={(value) => setPwState({ mode: 'set', value })}
                controlProps={{
                  'aria-label': 'Пароль на открытие',
                  maxLength: 64,
                  autoComplete: 'new-password',
                }}
              />
              <Button disabled={draft.pdfa} onClick={() => setShowPw((s) => !s)}>
                {showPw ? 'Скрыть' : 'Показать'}
              </Button>
              {template.pdfPasswordSet && (
                <Button onClick={() => setPwState({ mode: 'keep', value: '' })}>Отмена</Button>
              )}
            </div>
          </Field>
        )}
        {PROTECTION.map(({ key, label }) => (
          <Checkbox
            key={key}
            checked={draft.prot[key]}
            disabled={draft.pdfa}
            onUpdate={(v) => set({ prot: { ...draft.prot, [key]: v } })}
          >
            {label}
          </Checkbox>
        ))}
        <Text color="secondary">
          Запреты выполняют программы просмотра PDF; это не криптографическая защита. Без пароля на
          открытие документ откроет любой.
        </Text>
        <Text color="secondary">
          Защита применяется к сформированным отчётам; предпросмотр показывается без неё.
        </Text>
      </Card>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Button
          view="action"
          onClick={() => save.mutate()}
          loading={save.isPending}
          disabled={!dirty}
        >
          Сохранить настройки PDF
        </Button>
        {dirty && stale && (
          <Text color="warning">
            Настройки изменились на сервере — сохранение перезапишет изменения
          </Text>
        )}
        {dirty && (
          <>
            <Text color="warning">Есть несохранённые изменения</Text>
            <Button
              view="flat"
              onClick={() => (
                save.reset(),
                reseed(template),
                setPw({ mode: template.pdfPasswordSet ? 'keep' : 'set', value: '' })
              )}
            >
              Отменить
            </Button>
          </>
        )}
      </div>
      <GeneralError error={save.error} errors={errors} shown={shown} />

      <Card view="outlined" style={{ padding: 16 }} className="cr-stack">
        <Text variant="subheader-2">Приложенные файлы</Text>
        <Text color="secondary">
          PDF-файлы добавляются в начало или в конец отчёта: титульный лист, условия, приложения. До
          10 файлов по 20 МБ, всего до 500 страниц. Водяной знак и нумерация действуют и на них.
        </Text>
        {template.attachments.length === 0 && <Text color="secondary">Файлов нет.</Text>}
        {[...groups.start, ...groups.end].map((a) => {
          const group = groups[a.placement];
          const i = group.findIndex((x) => x.id === a.id);
          const move = (body: { placement?: 'start' | 'end'; sortOrder?: number }) =>
            files.mutate(() => api.templates.moveAttachment(template.id, a.id, body));
          return (
            <div
              key={a.id}
              data-testid="pdf-attachment"
              style={{ display: 'flex', gap: 8, alignItems: 'center' }}
            >
              <Label size="s">{a.placement === 'start' ? 'в начале' : 'в конце'}</Label>
              <Text style={{ flex: 1 }}>{a.name}</Text>
              <Text color="secondary">
                {a.pages} стр., {kb(a.size)}
              </Text>
              {a.pdfa && (
                <Label size="s" theme="info">
                  PDF/A
                </Label>
              )}
              <Button
                view="flat"
                size="s"
                disabled={i === 0 || files.isPending}
                onClick={() => move({ sortOrder: i - 1 })}
                aria-label={`${a.name}: выше`}
              >
                <Icon data={ArrowUp} />
              </Button>
              <Button
                view="flat"
                size="s"
                disabled={i === group.length - 1 || files.isPending}
                onClick={() => move({ sortOrder: i + 1 })}
                aria-label={`${a.name}: ниже`}
              >
                <Icon data={ArrowDown} />
              </Button>
              <Button
                view="flat"
                size="s"
                disabled={files.isPending}
                onClick={() => move({ placement: a.placement === 'start' ? 'end' : 'start' })}
                aria-label={`${a.name}: ${a.placement === 'start' ? 'в конец' : 'в начало'}`}
              >
                {a.placement === 'start' ? 'В конец' : 'В начало'}
              </Button>
              <Button
                view="flat-danger"
                size="s"
                disabled={files.isPending}
                onClick={() => setRemoving(a)}
                aria-label={`${a.name}: удалить`}
              >
                <Icon data={TrashBin} />
              </Button>
            </div>
          );
        })}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Select
            value={[placement]}
            options={PLACEMENTS}
            onUpdate={([v]) => setPlacement(v as 'start' | 'end')}
            aria-label="Куда добавить файл"
          />
          <input
            ref={fileRef}
            type="file"
            accept="application/pdf,.pdf"
            hidden
            aria-label="Файл PDF для приложения"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) upload(f);
            }}
          />
          <Button onClick={() => fileRef.current?.click()} loading={files.isPending}>
            Загрузить PDF
          </Button>
        </div>
        <ErrorAlert error={files.error} />
      </Card>
      <Text color="secondary">
        Результат — на вкладке «Предпросмотр», кнопка «Сгенерировать PDF».
      </Text>

      <ConfirmDialog
        open={removing !== null}
        title="Удалить приложенный файл?"
        text={removing ? `Файл «${removing.name}» больше не будет добавляться к отчёту.` : ''}
        confirmText="Удалить"
        danger
        loading={files.isPending}
        onConfirm={() =>
          removing && files.mutate(() => api.templates.removeAttachment(template.id, removing.id))
        }
        onCancel={() => setRemoving(null)}
      />
    </div>
  );
}
