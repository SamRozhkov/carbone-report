import {
  hasPdfProtection,
  normalizePdfOptions,
  type PdfMetadata,
  type PdfOptions,
  type PdfPageNumbers,
  type PdfProtection,
  type PdfSignature,
  type PdfSignaturePosition,
  type SignMethod,
  type PdfWatermark,
  type SavePdfOptionsBody,
  type TemplateAdminDetails,
  type TemplateAttachment,
} from '@carbone-reports/shared';
import { PAGE_FORMATS } from '@carbone-reports/shared/i18n';
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
import { useTranslation } from 'react-i18next';
import { api } from '../../../api/endpoints';
import { fieldErrors } from '../../../api/errors';
import { ConfirmDialog } from '../../../components/ConfirmDialog';
import { ErrorAlert } from '../../../components/ErrorAlert';
import { Field } from '../../../components/Field';
import { GeneralError } from '../../../components/GeneralError';
import type { TabProps } from './editorState';
import { applyTemplate } from './editorState';

const OPACITY = [10, 20, 30, 40, 50].map((n) => ({ value: String(n), content: `${n} %` }));
// Подписи вариантов — ключи editor:pdf.<поле>_<значение>.
const COLORS: PdfWatermark['color'][] = ['gray', 'red', 'blue'];
const ANGLES: PdfWatermark['angle'][] = ['diagonal', 'horizontal'];
const POSITIONS: PdfPageNumbers['position'][] = ['bottom-center', 'bottom-right', 'top-right'];
const PLACEMENTS = ['end', 'start'] as const;
const SIGNATURE_POSITIONS: PdfSignaturePosition[] = [
  'bottom-left',
  'bottom-center',
  'bottom-right',
];
const SIGN_METHODS: SignMethod[] = ['p12', 'gost'];
const META: (keyof PdfMetadata)[] = ['title', 'author', 'subject', 'keywords'];
const NO_PROTECTION: PdfProtection = { noPrint: false, noCopy: false, noModify: false };
const PROTECTION: (keyof PdfProtection)[] = ['noPrint', 'noCopy', 'noModify'];
type PwState = { mode: 'keep' | 'set' | 'remove'; value: string };

/** Черновик хранит выключенные блоки, чтобы флажок не стирал введённый текст. */
interface Draft {
  pdfa: boolean;
  wmOn: boolean;
  wm: PdfWatermark;
  pnOn: boolean;
  pn: PdfPageNumbers;
  meta: PdfMetadata;
  prot: PdfProtection;
  sigOn: boolean;
  sig: PdfSignature;
}

function toDraft(o: PdfOptions, pageFormat: string): Draft {
  return {
    pdfa: o.pdfa,
    wmOn: Boolean(o.watermark),
    wm: o.watermark ?? { text: '', opacity: 20, color: 'gray', angle: 'diagonal' },
    pnOn: Boolean(o.pageNumbers),
    // Формат не задан (шаблоны после 0017) — русский, как его строит buildPdfJob до Task 4 (§45.4);
    // формат языка интерфейса — только у блока, включённого сейчас.
    pn: o.pageNumbers
      ? { ...o.pageNumbers, format: o.pageNumbers.format ?? PAGE_FORMATS.ru }
      : {
          format: pageFormat,
          position: 'bottom-center',
          skipFirst: false,
        },
    meta: o.metadata ?? { title: '', author: '', subject: '', keywords: '' },
    prot: o.protection ?? NO_PROTECTION,
    sigOn: Boolean(o.signature),
    // Способ сохраняется явно: нет поля — '.p12' (§42.1).
    sig: {
      position: o.signature?.position ?? 'bottom-right',
      method: o.signature?.method ?? 'p12',
    },
  };
}

function fromDraft(d: Draft): PdfOptions {
  return normalizePdfOptions({
    pdfa: d.pdfa,
    ...(d.wmOn ? { watermark: d.wm } : {}),
    ...(d.pnOn ? { pageNumbers: d.pn } : {}),
    metadata: d.meta,
    protection: d.prot,
    ...(d.sigOn ? { signature: d.sig } : {}),
  });
}

const canon = (o: PdfOptions) => JSON.stringify(fromDraft(toDraft(o, PAGE_FORMATS.ru)));

export function PdfTab({ template }: Pick<TabProps, 'template'>) {
  const { t } = useTranslation();
  // Единые скобки {page}/{pages} подставляет рендер PDF, не i18next.
  const pageFormat = t('editor:pdf.pageFormatDefault');
  const options = <V extends string>(field: string, values: readonly V[]) =>
    values.map((value) => ({ value, content: t(`editor:pdf.${field}_${value}`) }));
  const kb = (n: number) => t('common:size.kb', { value: Math.max(1, Math.round(n / 1024)) });
  const queryClient = useQueryClient();
  const { add } = useToaster();
  const fileRef = useRef<HTMLInputElement>(null);
  const [baseline, setBaseline] = useState(template.pdfOptions);
  const [draft, setDraft] = useState<Draft>(() => toDraft(template.pdfOptions, pageFormat));
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
  const signatureOn = draft.sigOn;
  const dirty = JSON.stringify(fromDraft(draft)) !== canon(baseline) || pwDirty;
  // Настройки изменились на сервере: без несохранённых правок подхватываем, иначе — предупреждение.
  const stale = canon(template.pdfOptions) !== canon(baseline);
  const reseed = (tpl: TemplateAdminDetails) => {
    setBaseline(tpl.pdfOptions);
    setDraft(toDraft(tpl.pdfOptions, pageFormat));
  };
  if (stale && !dirty) reseed(template);

  const setPwState = (next: PwState) => {
    save.reset();
    setPw(next);
  };

  const save = useMutation({
    mutationFn: () => api.templates.savePdfOptions(template.id, { ...fromDraft(draft), ...pwBody }),
    onSuccess: (tpl) => {
      applyTemplate(queryClient, tpl);
      reseed(tpl);
      setPw({ mode: tpl.pdfPasswordSet ? 'keep' : 'set', value: '' });
      setShowPw(false);
      add({ name: `tpl-pdf-${Date.now()}`, title: t('editor:pdf.saved'), theme: 'success' });
    },
  });
  const files = useMutation({
    mutationFn: (op: () => Promise<TemplateAdminDetails>) => op(),
    onSuccess: (tpl) => {
      applyTemplate(queryClient, tpl);
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
        <Text color="secondary">{t('editor:pdf.pdfaHint')}</Text>
        {protectionOn && <Text color="secondary">{t('editor:pdf.unavailableProtection')}</Text>}
        {errorOf('pdfa') && <Text color="danger">{errors.pdfa}</Text>}
      </Card>

      <Card view="outlined" style={{ padding: 16 }} className="cr-stack">
        <Checkbox checked={draft.wmOn} onUpdate={(wmOn) => set({ wmOn })}>
          {t('editor:pdf.watermark')}
        </Checkbox>
        {draft.wmOn && (
          <>
            <Field
              label={t('editor:pdf.text')}
              hint={t('editor:pdf.tagHint')}
              error={errorOf('watermark.text')}
            >
              <TextInput
                value={draft.wm.text}
                onUpdate={(text) => set({ wm: { ...draft.wm, text } })}
                controlProps={{ 'aria-label': t('editor:pdf.watermarkTextAria'), maxLength: 200 }}
              />
            </Field>
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              <Field label={t('editor:pdf.opacity')}>
                <Select
                  value={[String(draft.wm.opacity)]}
                  options={OPACITY}
                  onUpdate={([v]) => set({ wm: { ...draft.wm, opacity: Number(v) } })}
                />
              </Field>
              <Field label={t('editor:pdf.color')}>
                <Select
                  value={[draft.wm.color]}
                  options={options('color', COLORS)}
                  onUpdate={([v]) =>
                    set({ wm: { ...draft.wm, color: v as PdfWatermark['color'] } })
                  }
                />
              </Field>
              <Field label={t('editor:pdf.angle')}>
                <Select
                  value={[draft.wm.angle]}
                  options={options('angle', ANGLES)}
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
          {t('editor:pdf.pageNumbers')}
        </Checkbox>
        {draft.pnOn && (
          <>
            <Field
              label={t('editor:pdf.format')}
              hint={t('editor:pdf.formatHint')}
              error={errorOf('pageNumbers.format')}
            >
              <TextInput
                value={draft.pn.format}
                onUpdate={(format) => set({ pn: { ...draft.pn, format } })}
                controlProps={{ 'aria-label': t('editor:pdf.formatAria'), maxLength: 100 }}
              />
            </Field>
            <Field label={t('editor:pdf.position')}>
              <Select
                value={[draft.pn.position]}
                options={options('position', POSITIONS)}
                onUpdate={([v]) =>
                  set({ pn: { ...draft.pn, position: v as PdfPageNumbers['position'] } })
                }
              />
            </Field>
            <Checkbox
              checked={draft.pn.skipFirst}
              onUpdate={(skipFirst) => set({ pn: { ...draft.pn, skipFirst } })}
            >
              {t('editor:pdf.skipFirst')}
            </Checkbox>
          </>
        )}
      </Card>

      <Card view="outlined" style={{ padding: 16 }} className="cr-stack">
        <Text variant="subheader-2">{t('editor:pdf.metadata')}</Text>
        <Text color="secondary">{t('editor:pdf.metadataHint')}</Text>
        {META.map((key) => (
          <Field key={key} label={t(`editor:pdf.meta_${key}`)} error={errorOf(`metadata.${key}`)}>
            <TextInput
              value={draft.meta[key]}
              onUpdate={(v) => set({ meta: { ...draft.meta, [key]: v } })}
              controlProps={{
                'aria-label': t('editor:pdf.metaAria', { label: t(`editor:pdf.meta_${key}`) }),
                maxLength: 500,
              }}
            />
          </Field>
        ))}
      </Card>

      <Card view="outlined" style={{ padding: 16 }} className="cr-stack">
        <Text variant="subheader-2">{t('editor:pdf.protection')}</Text>
        {draft.pdfa && <Text color="secondary">{t('editor:pdf.unavailablePdfa')}</Text>}
        {signatureOn && <Text color="secondary">{t('editor:pdf.unavailableSignature')}</Text>}
        {pw.mode === 'keep' ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Text>{t('editor:pdf.passwordSet')}</Text>
            <Button
              disabled={draft.pdfa || signatureOn}
              onClick={() => setPwState({ mode: 'set', value: '' })}
            >
              {t('editor:pdf.passwordChange')}
            </Button>
            <Button
              disabled={draft.pdfa || signatureOn}
              onClick={() => setPwState({ mode: 'remove', value: '' })}
            >
              {t('editor:pdf.passwordRemove')}
            </Button>
          </div>
        ) : pw.mode === 'remove' ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Text>{t('editor:pdf.passwordWillBeRemoved')}</Text>
            <Button onClick={() => setPwState({ mode: 'keep', value: '' })}>
              {t('common:action.cancel')}
            </Button>
          </div>
        ) : (
          <Field label={t('editor:pdf.password')} error={errorOf('password')}>
            <div style={{ display: 'flex', gap: 8 }}>
              <TextInput
                type={showPw ? 'text' : 'password'}
                value={pw.value}
                disabled={draft.pdfa || signatureOn}
                onUpdate={(value) => setPwState({ mode: 'set', value })}
                controlProps={{
                  'aria-label': t('editor:pdf.password'),
                  autoComplete: 'new-password',
                }}
              />
              <Button disabled={draft.pdfa || signatureOn} onClick={() => setShowPw((s) => !s)}>
                {showPw ? t('editor:pdf.hide') : t('editor:pdf.show')}
              </Button>
              {template.pdfPasswordSet && (
                <Button onClick={() => setPwState({ mode: 'keep', value: '' })}>
                  {t('common:action.cancel')}
                </Button>
              )}
            </div>
          </Field>
        )}
        {PROTECTION.map((key) => (
          <Checkbox
            key={key}
            checked={draft.prot[key]}
            disabled={draft.pdfa || signatureOn}
            onUpdate={(v) => set({ prot: { ...draft.prot, [key]: v } })}
          >
            {t(`editor:pdf.prot_${key}`)}
          </Checkbox>
        ))}
        <Text color="secondary">{t('editor:pdf.protectionNote')}</Text>
        <Text color="secondary">{t('editor:pdf.protectionPreview')}</Text>
      </Card>

      <Card view="outlined" style={{ padding: 16 }} className="cr-stack">
        <Text variant="subheader-2">{t('editor:pdf.signature')}</Text>
        {protectionOn && <Text color="secondary">{t('editor:pdf.unavailableProtection')}</Text>}
        <Checkbox
          checked={draft.sigOn}
          disabled={protectionOn}
          onUpdate={(sigOn) => set({ sigOn })}
        >
          {t('editor:pdf.allowSignature')}
        </Checkbox>
        {draft.sigOn && (
          <>
            <Field label={t('editor:pdf.signMethod')}>
              <Select
                value={[draft.sig.method ?? 'p12']}
                options={options('method', SIGN_METHODS)}
                onUpdate={([method]) =>
                  set({ sig: { ...draft.sig, method: method as SignMethod } })
                }
                aria-label={t('editor:pdf.signMethod')}
              />
            </Field>
            {draft.sig.method === 'gost' && (
              <Text color="secondary">{t('editor:pdf.gostHint')}</Text>
            )}
            <Field label={t('editor:pdf.stampPosition')}>
              <Select
                value={[draft.sig.position]}
                options={options('position', SIGNATURE_POSITIONS)}
                onUpdate={([position]) =>
                  set({ sig: { ...draft.sig, position: position as PdfSignaturePosition } })
                }
                aria-label={t('editor:pdf.stampPosition')}
              />
            </Field>
          </>
        )}
        <Text color="secondary">{t('editor:pdf.signatureNote')}</Text>
        <Text color="secondary">{t('editor:pdf.stampNote')}</Text>
        {errorOf('signature') && <Text color="danger">{errors.signature}</Text>}
      </Card>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Button
          view="action"
          onClick={() => save.mutate()}
          loading={save.isPending}
          disabled={!dirty}
        >
          {t('editor:pdf.save')}
        </Button>
        {dirty && stale && <Text color="warning">{t('editor:pdf.stale')}</Text>}
        {dirty && (
          <>
            <Text color="warning">{t('editor:draft.unsaved')}</Text>
            <Button
              view="flat"
              onClick={() => (
                save.reset(),
                reseed(template),
                setPw({ mode: template.pdfPasswordSet ? 'keep' : 'set', value: '' })
              )}
            >
              {t('editor:draft.discard')}
            </Button>
          </>
        )}
      </div>
      <GeneralError error={save.error} errors={errors} shown={shown} />

      <Card view="outlined" style={{ padding: 16 }} className="cr-stack">
        <Text variant="subheader-2">{t('editor:pdf.attachments')}</Text>
        <Text color="secondary">{t('editor:pdf.attachmentsHint')}</Text>
        {template.attachments.length === 0 && (
          <Text color="secondary">{t('editor:pdf.noAttachments')}</Text>
        )}
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
              <Label size="s">{t(`editor:pdf.at_${a.placement}`)}</Label>
              <Text style={{ flex: 1 }}>{a.name}</Text>
              <Text color="secondary">
                {t('editor:pdf.attachmentInfo', {
                  pages: t('editor:pdf.pages', { count: a.pages }),
                  size: kb(a.size),
                })}
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
                aria-label={t('editor:pdf.upAria', { name: a.name })}
              >
                <Icon data={ArrowUp} />
              </Button>
              <Button
                view="flat"
                size="s"
                disabled={i === group.length - 1 || files.isPending}
                onClick={() => move({ sortOrder: i + 1 })}
                aria-label={t('editor:pdf.downAria', { name: a.name })}
              >
                <Icon data={ArrowDown} />
              </Button>
              <Button
                view="flat"
                size="s"
                disabled={files.isPending}
                onClick={() => move({ placement: a.placement === 'start' ? 'end' : 'start' })}
                aria-label={t(`editor:pdf.moveAria_${a.placement === 'start' ? 'end' : 'start'}`, {
                  name: a.name,
                })}
              >
                {t(`editor:pdf.placement_${a.placement === 'start' ? 'end' : 'start'}`)}
              </Button>
              <Button
                view="flat-danger"
                size="s"
                disabled={files.isPending}
                onClick={() => setRemoving(a)}
                aria-label={t('editor:pdf.removeAria', { name: a.name })}
              >
                <Icon data={TrashBin} />
              </Button>
            </div>
          );
        })}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Select
            value={[placement]}
            options={options('placement', PLACEMENTS)}
            onUpdate={([v]) => setPlacement(v as 'start' | 'end')}
            aria-label={t('editor:pdf.placementAria')}
          />
          <input
            ref={fileRef}
            type="file"
            accept="application/pdf,.pdf"
            hidden
            aria-label={t('editor:pdf.fileAria')}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) upload(f);
            }}
          />
          <Button onClick={() => fileRef.current?.click()} loading={files.isPending}>
            {t('editor:pdf.upload')}
          </Button>
        </div>
        <ErrorAlert error={files.error} />
      </Card>
      <Text color="secondary">{t('editor:pdf.resultHint')}</Text>

      <ConfirmDialog
        open={removing !== null}
        title={t('editor:pdf.removeTitle')}
        text={removing ? t('editor:pdf.removeText', { name: removing.name }) : ''}
        confirmText={t('common:action.delete')}
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
