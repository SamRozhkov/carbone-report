import type { TemplateExt } from '@carbone-reports/shared';
import type { TemplateRow } from '../../db/schema';
import type { AppDeps } from '../../deps';
import type { SessionUser } from '../auth/session';
import { signFileToken, signOnlyOffice } from './jwt';

const DOCUMENT_TYPE: Record<TemplateExt, 'word' | 'cell' | 'slide'> = {
  docx: 'word',
  odt: 'word',
  xlsx: 'cell',
  ods: 'cell',
  pptx: 'slide',
};

export async function buildEditorConfig(
  deps: AppDeps,
  row: TemplateRow,
  user: SessionUser,
  edit: boolean,
) {
  const base = deps.config.apiInternalUrl;
  const t = await signFileToken(row.id, deps.config.appSecret);
  const config = {
    document: {
      fileType: row.fileExt,
      key: row.docKey,
      title: `${row.name}.${row.fileExt}`,
      url: `${base}/internal/templates/${row.id}/file?t=${encodeURIComponent(t)}`,
      permissions: { edit, download: true, print: true },
    },
    documentType: DOCUMENT_TYPE[row.fileExt],
    editorConfig: {
      // Просмотр — та же сессия документа: правки редактора видны на лету (проверено 2026-10-15, §38.3).
      ...(edit ? {} : { mode: 'view' as const }),
      callbackUrl: `${base}/internal/onlyoffice/callback/${row.id}`,
      user: { id: user.id, name: user.login },
      lang: 'ru',
      region: 'ru-RU',
      // Быстрый режим без переключателя: правки сразу уходят на Document Server, и forcesave по кнопке
      // «Сохранить» их видит. В строгом режиме (браузер запоминает выбор) forcesave отвечает «изменений нет».
      coEditing: { mode: 'fast', change: false },
      customization: { forcesave: true, autosave: true },
    },
  };
  return { ...config, token: await signOnlyOffice(config, deps.config.onlyofficeJwtSecret) };
}

export type EditorConfig = Awaited<ReturnType<typeof buildEditorConfig>>;
