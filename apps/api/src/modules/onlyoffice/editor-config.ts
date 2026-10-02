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

export async function buildEditorConfig(deps: AppDeps, row: TemplateRow, user: SessionUser) {
  const base = deps.config.apiInternalUrl;
  const t = await signFileToken(row.id, deps.config.appSecret);
  const config = {
    document: {
      fileType: row.fileExt,
      key: row.docKey,
      title: `${row.name}.${row.fileExt}`,
      url: `${base}/internal/templates/${row.id}/file?t=${encodeURIComponent(t)}`,
      permissions: { edit: true, download: true, print: true },
    },
    documentType: DOCUMENT_TYPE[row.fileExt],
    editorConfig: {
      callbackUrl: `${base}/internal/onlyoffice/callback/${row.id}`,
      user: { id: user.id, name: user.login },
      lang: 'ru',
      region: 'ru-RU',
      customization: { forcesave: true, autosave: true },
    },
  };
  return { ...config, token: await signOnlyOffice(config, deps.config.onlyofficeJwtSecret) };
}

export type EditorConfig = Awaited<ReturnType<typeof buildEditorConfig>>;
