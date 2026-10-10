import type {
  BackupDto,
  BackupOperationDto,
  CategoryBody,
  CategoryDto,
  CategoryPatch,
  CreateTemplateBody,
  CreateUserBody,
  DatasourceBody,
  DatasourceDto,
  GroupBody,
  GroupDto,
  GroupPatch,
  LoginBody,
  MaintenanceStatus,
  OutputFormat,
  ParamOptionsResult,
  ParamsInput,
  RenderBody,
  RunQueryBody,
  RunQueryResult,
  RunsPage,
  RunsQuery,
  TemplateAccess,
  TemplateAdminDetails,
  TemplateDetails,
  TemplateParam,
  TemplateQuery,
  TemplateSummary,
  UpdateTemplateBody,
  UpdateUserBody,
  UserDto,
  RecoveryBody,
} from '@carbone-reports/shared';
import type { Config } from '@onlyoffice/doceditor-types';
import { apiBlob, apiJson } from './client';
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
    create: (body: CreateUserBody) => apiJson<UserDto>('/api/users', post(body)),
    update: (id: string, body: UpdateUserBody) => apiJson<UserDto>(`/api/users/${id}`, patch(body)),
    remove: (id: string) => apiJson<void>(`/api/users/${id}`, del),
    revokeSessions: (id: string) => apiJson<void>(`/api/users/${id}/sessions/revoke`, post()),
    setGroups: (id: string, groupIds: string[]) =>
      apiJson<string[]>(`/api/users/${id}/groups`, put({ groupIds })),
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
    create: (body: DatasourceBody) => apiJson<DatasourceDto>('/api/datasources', post(body)),
    update: (id: string, body: DatasourceBody) =>
      apiJson<DatasourceDto>(`/api/datasources/${id}`, patch(body)),
    remove: (id: string) => apiJson<void>(`/api/datasources/${id}`, del),
    test: (body: DatasourceBody) => apiJson<TestResult>('/api/datasources/test', post(body)),
    testSaved: (id: string) => apiJson<TestResult>(`/api/datasources/${id}/test`, post()),
  },

  templates: {
    list: () => apiJson<TemplateSummary[]>('/api/templates'),
    get: (id: string) => apiJson<TemplateDetails>(`/api/templates/${id}`),
    getAdmin: (id: string) => apiJson<TemplateAdminDetails>(`/api/templates/${id}`),
    create: (body: CreateTemplateBody) => apiJson<TemplateSummary>('/api/templates', post(body)),
    upload: (form: FormData) =>
      apiJson<TemplateSummary>('/api/templates/upload', { method: 'POST', body: form }),
    replaceFile: (id: string, form: FormData) =>
      apiJson<TemplateAdminDetails>(`/api/templates/${id}/file`, { method: 'PUT', body: form }),
    update: (id: string, body: UpdateTemplateBody) =>
      apiJson<TemplateAdminDetails>(`/api/templates/${id}`, patch(body)),
    remove: (id: string) => apiJson<void>(`/api/templates/${id}`, del),
    duplicate: (id: string) => apiJson<TemplateSummary>(`/api/templates/${id}/duplicate`, post()),
    saveQueries: (id: string, queries: TemplateQuery[]) =>
      apiJson<TemplateAdminDetails>(`/api/templates/${id}/queries`, put(queries)),
    saveParams: (id: string, params: TemplateParam[]) =>
      apiJson<TemplateAdminDetails>(`/api/templates/${id}/params`, put(params)),
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
    editorConfig: (id: string) => apiJson<Config>(`/api/templates/${id}/editor-config`),
    save: (id: string) => apiJson<void>(`/api/templates/${id}/save`, post()),
    getAccess: (id: string) => apiJson<TemplateAccess>(`/api/templates/${id}/access`),
    access: (id: string, body: TemplateAccess) =>
      apiJson<TemplateAccess>(`/api/templates/${id}/access`, put(body)),
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

export const runFileUrl = (
  runId: string,
  opts: { format?: OutputFormat; inline?: boolean } = {},
) => {
  const sp = new URLSearchParams();
  if (opts.format) sp.set('format', opts.format);
  if (opts.inline) sp.set('inline', '1');
  const qs = sp.toString();
  return `/api/runs/${runId}/file${qs ? `?${qs}` : ''}`;
};
export const templateDownloadUrl = (id: string) => `/api/templates/${id}/download`;
