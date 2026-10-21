import type {
  AccessTemplateRow,
  BackupDto,
  BackupOperationDto,
  CertificateInfo,
  CategoryBody,
  CategoryDto,
  CategoryPatch,
  CreateTemplateBody,
  CreateUserBody,
  DatasourceBody,
  DatasourceDto,
  DatasourceOption,
  EditLockBody,
  EditLockState,
  GostPrepareResult,
  GroupBody,
  GroupDto,
  GroupPatch,
  LoginBody,
  MoveAttachmentBody,
  MyCertificate,
  MaintenanceStatus,
  OutputFormat,
  ParamOptionsResult,
  ParamsInput,
  RenderBody,
  RunQueryBody,
  RunQueryResult,
  RunSignature,
  RunsPage,
  Role,
  RunsQuery,
  SavePdfOptionsBody,
  TemplateAccess,
  TemplateAdminDetails,
  TemplateChart,
  TemplateDetails,
  TemplateEditSummary,
  TemplateEditors,
  TemplateParam,
  TemplateQuery,
  TemplateSummary,
  TemplateTagWarnings,
  UpdateTemplateBody,
  UpdateUserBody,
  UserDirectoryEntry,
  UserDto,
  RecoveryBody,
} from '@carbone-reports/shared';
import type { ImportPreview, ImportResult } from '@carbone-reports/shared/template-transfer';
import type { Config } from '@onlyoffice/doceditor-types';
import { apiBlob, apiFile, apiJson } from './client';
import type { SessionUser } from './session';

export type TestResult = { ok: true } | { ok: false; message: string };

const post = (json?: unknown) => ({ method: 'POST', json });
const put = (json: unknown) => ({ method: 'PUT', json });
const patch = (json: unknown) => ({ method: 'PATCH', json });
const del = { method: 'DELETE' };

export interface VersionDto {
  version: string;
  commit: string;
  builtAt: string;
}

export const api = {
  version: () => apiJson<VersionDto>('/api/version'),
  me: () => apiJson<SessionUser>('/api/auth/me'),
  login: (body: LoginBody) => apiJson<SessionUser>('/api/auth/login', post(body)),
  logout: () => apiJson<void>('/api/auth/logout', post()),
  logoutAll: () => apiJson<void>('/api/auth/logout-all', post()),

  users: {
    list: () => apiJson<UserDto[]>('/api/users'),
    /** Справочник активных пользователей (§43.3): открыт и распорядителю доступа, и редактору. */
    directory: (role?: Role) =>
      apiJson<UserDirectoryEntry[]>(`/api/users/directory${role ? `?role=${role}` : ''}`),
    create: (body: CreateUserBody) => apiJson<UserDto>('/api/users', post(body)),
    update: (id: string, body: UpdateUserBody) => apiJson<UserDto>(`/api/users/${id}`, patch(body)),
    remove: (id: string) => apiJson<void>(`/api/users/${id}`, del),
    removeCertificate: (id: string) => apiJson<void>(`/api/users/${id}/certificate`, del),
    revokeSessions: (id: string) => apiJson<void>(`/api/users/${id}/sessions/revoke`, post()),
    setGroups: (id: string, groupIds: string[]) =>
      apiJson<string[]>(`/api/users/${id}/groups`, put({ groupIds })),
  },

  signature: {
    get: () => apiJson<MyCertificate>('/api/me/certificate'),
    upload: (form: FormData) =>
      apiJson<CertificateInfo>('/api/me/certificate', { method: 'POST', body: form }),
    remove: () => apiJson<void>('/api/me/certificate', del),
  },

  groups: {
    list: () => apiJson<GroupDto[]>('/api/groups'),
    create: (body: GroupBody) => apiJson<GroupDto>('/api/groups', post(body)),
    update: (id: string, body: GroupPatch) => apiJson<GroupDto>(`/api/groups/${id}`, patch(body)),
    remove: (id: string) => apiJson<void>(`/api/groups/${id}`, del),
    setMembers: (id: string, userIds: string[]) =>
      apiJson<GroupDto>(`/api/groups/${id}/members`, put({ userIds })),
  },

  categories: {
    list: () => apiJson<CategoryDto[]>('/api/categories'),
    create: (body: CategoryBody) => apiJson<CategoryDto>('/api/categories', post(body)),
    update: (id: string, body: CategoryPatch) =>
      apiJson<CategoryDto>(`/api/categories/${id}`, patch(body)),
    remove: (id: string) => apiJson<void>(`/api/categories/${id}`, del),
    setGroups: (id: string, groupIds: string[]) =>
      apiJson<CategoryDto>(`/api/categories/${id}/groups`, put({ groupIds })),
  },

  datasources: {
    list: () => apiJson<DatasourceDto[]>('/api/datasources'),
    /** Только id и имя (§43.3): для выбора источника в шаблоне, доступно и редактору. */
    options: () => apiJson<DatasourceOption[]>('/api/datasources/options'),
    create: (body: DatasourceBody) => apiJson<DatasourceDto>('/api/datasources', post(body)),
    update: (id: string, body: DatasourceBody) =>
      apiJson<DatasourceDto>(`/api/datasources/${id}`, patch(body)),
    remove: (id: string) => apiJson<void>(`/api/datasources/${id}`, del),
    test: (body: DatasourceBody) => apiJson<TestResult>('/api/datasources/test', post(body)),
    testSaved: (id: string) => apiJson<TestResult>(`/api/datasources/${id}/test`, post()),
  },

  templates: {
    list: () => apiJson<TemplateSummary[]>('/api/templates'),
    /** Шаблоны, которые текущий пользователь может править (§43.3). */
    listEditable: () => apiJson<TemplateEditSummary[]>('/api/templates?scope=edit'),
    get: (id: string) => apiJson<TemplateDetails>(`/api/templates/${id}`),
    getAdmin: (id: string) => apiJson<TemplateAdminDetails>(`/api/templates/${id}`),
    tagWarnings: (id: string) => apiJson<TemplateTagWarnings>(`/api/templates/${id}/tag-warnings`),
    create: (body: CreateTemplateBody) => apiJson<TemplateSummary>('/api/templates', post(body)),
    upload: (form: FormData) =>
      apiJson<TemplateSummary>('/api/templates/upload', { method: 'POST', body: form }),
    replaceFile: (id: string, form: FormData, holder?: string) =>
      apiJson<TemplateAdminDetails>(
        `/api/templates/${id}/file${holder ? `?holder=${encodeURIComponent(holder)}` : ''}`,
        { method: 'PUT', body: form },
      ),
    update: (id: string, body: UpdateTemplateBody) =>
      apiJson<TemplateAdminDetails>(`/api/templates/${id}`, patch(body)),
    remove: (id: string) => apiJson<void>(`/api/templates/${id}`, del),
    /** Выгрузка в архив .crt.zip (§33.2); имя файла — из Content-Disposition. */
    export: (ids: string[]) => apiFile('/api/templates/export', post({ ids })),
    importPreview: (form: FormData) =>
      apiJson<ImportPreview>('/api/templates/import/preview', { method: 'POST', body: form }),
    importApply: (form: FormData) =>
      apiJson<ImportResult>('/api/templates/import', { method: 'POST', body: form }),
    duplicate: (id: string) => apiJson<TemplateSummary>(`/api/templates/${id}/duplicate`, post()),
    saveQueries: (id: string, queries: TemplateQuery[]) =>
      apiJson<TemplateAdminDetails>(`/api/templates/${id}/queries`, put(queries)),
    saveParams: (id: string, params: TemplateParam[]) =>
      apiJson<TemplateAdminDetails>(`/api/templates/${id}/params`, put(params)),
    saveCharts: (id: string, charts: TemplateChart[]) =>
      apiJson<TemplateAdminDetails>(`/api/templates/${id}/charts`, put(charts)),
    savePdfOptions: (id: string, options: SavePdfOptionsBody) =>
      apiJson<TemplateAdminDetails>(`/api/templates/${id}/pdf-options`, put(options)),
    uploadAttachment: (id: string, form: FormData) =>
      apiJson<TemplateAdminDetails>(`/api/templates/${id}/attachments`, {
        method: 'POST',
        body: form,
      }),
    moveAttachment: (id: string, aid: string, body: MoveAttachmentBody) =>
      apiJson<TemplateAdminDetails>(`/api/templates/${id}/attachments/${aid}`, patch(body)),
    removeAttachment: (id: string, aid: string) =>
      apiJson<TemplateAdminDetails>(`/api/templates/${id}/attachments/${aid}`, del),
    runQuery: (id: string, body: RunQueryBody) =>
      apiJson<RunQueryResult>(`/api/templates/${id}/queries/run`, post(body)),
    paramOptions: (id: string, name: string, params: ParamsInput) =>
      apiJson<ParamOptionsResult>(
        `/api/templates/${id}/params/${encodeURIComponent(name)}/options`,
        post({ params }),
      ),
    previewData: (id: string, params: ParamsInput) =>
      apiJson<Record<string, unknown>>(
        `/api/templates/${id}/preview`,
        post({ params, mode: 'data' }),
      ),
    previewPdf: (id: string, params: ParamsInput) =>
      apiBlob(`/api/templates/${id}/preview`, post({ params, mode: 'pdf' })),
    editorConfig: (id: string, holder: string) =>
      apiJson<Config>(`/api/templates/${id}/editor-config?holder=${encodeURIComponent(holder)}`),
    save: (id: string, holder: string) =>
      apiJson<void>(`/api/templates/${id}/save`, post({ holder })),
    editLock: (id: string, body: EditLockBody) =>
      apiJson<EditLockState>(`/api/templates/${id}/edit-lock`, post(body)),
    takeoverEditLock: (id: string, holder: string) =>
      apiJson<EditLockState>(`/api/templates/${id}/edit-lock/takeover`, post({ holder })),
    getAccess: (id: string) => apiJson<TemplateAccess>(`/api/templates/${id}/access`),
    access: (id: string, body: TemplateAccess) =>
      apiJson<TemplateAccess>(`/api/templates/${id}/access`, put(body)),
    editors: (id: string) => apiJson<TemplateEditors>(`/api/templates/${id}/editors`),
    setEditors: (id: string, userIds: string[]) =>
      apiJson<TemplateEditors>(`/api/templates/${id}/editors`, put({ userIds })),
    setOwner: (id: string, userId: string) =>
      apiJson<TemplateEditors>(`/api/templates/${id}/owner`, put({ userId })),
  },

  access: {
    /** Все шаблоны для страницы «Доступ к отчётам» (§43.5). */
    templates: () => apiJson<AccessTemplateRow[]>('/api/access/templates'),
  },

  reports: {
    render: (id: string, body: RenderBody) =>
      apiJson<{ runId: string }>(`/api/reports/${id}/render`, post(body)),
  },

  runs: {
    list: (q: Partial<RunsQuery>) => {
      const sp = new URLSearchParams();
      for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') sp.set(k, String(v));
      const qs = sp.toString();
      return apiJson<RunsPage>(`/api/runs${qs ? `?${qs}` : ''}`);
    },
    sign: (id: string, password: string) =>
      apiJson<RunSignature>(`/api/runs/${id}/sign`, post({ password })),
    gostPrepare: (id: string, certificate: string) =>
      apiJson<GostPrepareResult>(`/api/runs/${id}/sign/gost/prepare`, post({ certificate })),
    gostComplete: (id: string, signature: string) =>
      apiJson<RunSignature>(`/api/runs/${id}/sign/gost/complete`, post({ signature })),
  },

  backups: {
    list: () => apiJson<BackupDto[]>('/api/admin/backups'),
    create: () => apiJson<{ operationId: string }>('/api/admin/backups', post()),
    restore: (name: string) =>
      apiJson<{ operationId: string }>(
        `/api/admin/backups/${encodeURIComponent(name)}/restore`,
        post(),
      ),
    /** null — операций ещё не было (204): данные запроса TanStack Query не могут быть undefined. */
    operation: async () =>
      (await apiJson<BackupOperationDto | undefined>('/api/admin/backups/operation')) ?? null,
  },

  maintenance: {
    status: () => apiJson<MaintenanceStatus>('/api/maintenance'),
    retry: (body: RecoveryBody) =>
      apiJson<{ operationId: string }>('/api/maintenance/retry', post(body)),
  },
};

/** Формат файла запуска: собранный формат или открепленная подпись ГОСТ (`.sig`, §42.6). */
export type RunFileFormat = OutputFormat | 'sig';

export const runFileUrl = (
  runId: string,
  opts: { format?: RunFileFormat; inline?: boolean; signed?: boolean } = {},
) => {
  const sp = new URLSearchParams();
  if (opts.format) sp.set('format', opts.format);
  if (opts.inline) sp.set('inline', '1');
  if (opts.signed) sp.set('signed', '1');
  const qs = sp.toString();
  return `/api/runs/${runId}/file${qs ? `?${qs}` : ''}`;
};
/** Освобождение блокировки при уходе со страницы: запрос переживает закрытие вкладки (§38.1). */
export function releaseEditLock(id: string, holder: string): void {
  void fetch(`/api/templates/${id}/edit-lock?holder=${encodeURIComponent(holder)}`, {
    method: 'DELETE',
    keepalive: true,
    credentials: 'same-origin',
  }).catch(() => undefined);
}

export const templateDownloadUrl = (id: string) => `/api/templates/${id}/download`;
