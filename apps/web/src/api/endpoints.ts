import type {
  CreateTemplateBody,
  CreateUserBody,
  DatasourceBody,
  DatasourceDto,
  LoginBody,
  ParamsInput,
  RenderBody,
  RunQueryBody,
  RunQueryResult,
  RunsPage,
  RunsQuery,
  TemplateAdminDetails,
  TemplateDetails,
  TemplateParam,
  TemplateQuery,
  TemplateSummary,
  UpdateTemplateBody,
  UpdateUserBody,
  UserDto,
} from '@carbone-reports/shared';
import type { Config } from '@onlyoffice/doceditor-types';
import { apiBlob, apiJson } from './client';
import type { SessionUser } from './session';

export type TestResult = { ok: true } | { ok: false; message: string };

const post = (json?: unknown) => ({ method: 'POST', json });
const put = (json: unknown) => ({ method: 'PUT', json });
const patch = (json: unknown) => ({ method: 'PATCH', json });
const del = { method: 'DELETE' };

export const api = {
  me: () => apiJson<SessionUser>('/api/auth/me'),
  login: (body: LoginBody) => apiJson<SessionUser>('/api/auth/login', post(body)),
  logout: () => apiJson<void>('/api/auth/logout', post()),

  users: {
    list: () => apiJson<UserDto[]>('/api/users'),
    create: (body: CreateUserBody) => apiJson<UserDto>('/api/users', post(body)),
    update: (id: string, body: UpdateUserBody) => apiJson<UserDto>(`/api/users/${id}`, patch(body)),
    remove: (id: string) => apiJson<void>(`/api/users/${id}`, del),
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
    previewData: (id: string, params: ParamsInput) =>
      apiJson<Record<string, unknown>>(
        `/api/templates/${id}/preview`,
        post({ params, mode: 'data' }),
      ),
    previewPdf: (id: string, params: ParamsInput) =>
      apiBlob(`/api/templates/${id}/preview`, post({ params, mode: 'pdf' })),
    editorConfig: (id: string) => apiJson<Config>(`/api/templates/${id}/editor-config`),
    save: (id: string) => apiJson<void>(`/api/templates/${id}/save`, post()),
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
};

export const runFileUrl = (runId: string, inline = false) =>
  `/api/runs/${runId}/file${inline ? '?inline=1' : ''}`;
export const templateDownloadUrl = (id: string) => `/api/templates/${id}/download`;
