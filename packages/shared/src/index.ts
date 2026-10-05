import { z } from 'zod';

z.config(z.locales.ru());

export const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const RESERVED_NAMES = new Set(['__proto__', 'constructor', 'prototype']);
const notReserved = (s: string) => !RESERVED_NAMES.has(s);
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const Role = z.enum(['admin', 'user']);
export type Role = z.infer<typeof Role>;

export const TemplateExt = z.enum(['docx', 'xlsx', 'odt', 'ods', 'pptx']);
export type TemplateExt = z.infer<typeof TemplateExt>;

export const OutputFormat = z.enum(['pdf', 'docx', 'xlsx', 'odt', 'ods', 'pptx']);
export type OutputFormat = z.infer<typeof OutputFormat>;

const FORMATS_BY_EXT: Record<TemplateExt, OutputFormat[]> = {
  docx: ['pdf', 'docx', 'odt'],
  odt: ['pdf', 'docx', 'odt'],
  xlsx: ['pdf', 'xlsx', 'ods'],
  ods: ['pdf', 'xlsx', 'ods'],
  pptx: ['pdf', 'pptx'],
};

export function outputFormatsFor(ext: TemplateExt): OutputFormat[] {
  return FORMATS_BY_EXT[ext];
}

export const ParamType = z.enum(['string', 'number', 'date', 'boolean', 'select', 'query']);
export type ParamType = z.infer<typeof ParamType>;

export const SelectOption = z.object({ value: z.string().min(1), label: z.string().min(1) });
export type SelectOption = z.infer<typeof SelectOption>;

export const ScalarValue = z.union([z.string(), z.number()]);
export const ParamValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(ScalarValue),
]);
export type ParamValue = z.infer<typeof ParamValue>;

export const MAX_PARAM_OPTIONS = 1000;

const TemplateParamFields = z.object({
  name: z
    .string()
    .regex(IDENT_RE, 'имя: латиница, цифры и _')
    .refine(notReserved, 'зарезервированное имя'),
  label: z.string().min(1),
  type: ParamType,
  required: z.boolean(),
  defaultValue: ParamValue,
  options: z.array(SelectOption).min(1).nullable(),
  /** Только для type=query: запрос вариантов к источнику шаблона; :name — ссылки на другие параметры. */
  sql: z.string().nullable().default(null),
  multiple: z.boolean().default(false),
});

export const TemplateParam = TemplateParamFields.superRefine((p, ctx) => {
  const issue = (path: string, message: string) =>
    ctx.addIssue({ code: 'custom', path: [path], message });
  if (p.type === 'select' && !(p.options && p.options.length > 0))
    issue('options', 'для select нужен хотя бы один вариант');
  if (p.type === 'query') {
    if (!p.sql || !p.sql.trim()) issue('sql', 'укажите SQL-запрос вариантов');
    if (p.options !== null) issue('options', 'у SQL-списка варианты задаются запросом');
    if (Array.isArray(p.defaultValue) && !p.multiple)
      issue('defaultValue', 'несколько значений допустимы только при множественном выборе');
  } else {
    if (p.sql !== null) issue('sql', 'SQL допустим только у типа «SQL-список»');
    if (p.multiple) issue('multiple', 'множественный выбор допустим только у типа «SQL-список»');
    if (Array.isArray(p.defaultValue)) issue('defaultValue', 'недопустимое значение');
  }
});
export type TemplateParam = z.infer<typeof TemplateParam>;

/** Параметр в карточке шаблона: + имена параметров, на которые ссылается его SQL (у пользователя sql = null). */
export const TemplateParamDto = TemplateParamFields.extend({ dependsOn: z.array(z.string()) });
export type TemplateParamDto = z.infer<typeof TemplateParamDto>;

export const QueryMode = z.enum(['list', 'single']);
export type QueryMode = z.infer<typeof QueryMode>;

export const TemplateQuery = z.object({
  key: z
    .string()
    .regex(IDENT_RE, 'ключ: латиница, цифры и _')
    .refine((k) => k !== 'params', 'ключ "params" зарезервирован')
    .refine(notReserved, 'зарезервированное имя'),
  sql: z.string().trim().min(1),
  mode: QueryMode,
});
export type TemplateQuery = z.infer<typeof TemplateQuery>;

// ---- DTO ----

export const LoginBody = z.object({
  login: z.string().min(1),
  password: z.string().min(1).max(1024),
});
export type LoginBody = z.infer<typeof LoginBody>;

export const UserDto = z.object({
  id: z.string(),
  login: z.string(),
  role: Role,
  blocked: z.boolean(),
  groupIds: z.array(z.string()),
  createdAt: z.string(),
});
export type UserDto = z.infer<typeof UserDto>;

export const CreateUserBody = z.object({
  login: z.string().trim().min(3).max(64),
  password: z.string().min(8).max(1024),
  role: Role,
});
export type CreateUserBody = z.infer<typeof CreateUserBody>;

export const UpdateUserBody = z.object({
  password: z.string().min(8).max(1024).optional(),
  role: Role.optional(),
  blocked: z.boolean().optional(),
});
export type UpdateUserBody = z.infer<typeof UpdateUserBody>;

export const GroupDto = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  memberIds: z.array(z.string()),
  createdAt: z.string(),
});
export type GroupDto = z.infer<typeof GroupDto>;

export const GroupBody = z.object({
  name: z.string().trim().min(1, 'укажите название').max(100),
  description: z.string().trim().max(1000).default(''),
});
export type GroupBody = z.infer<typeof GroupBody>;

export const CategoryDto = z.object({
  id: z.string(),
  name: z.string(),
  sortOrder: z.number().int(),
  public: z.boolean(),
  groupIds: z.array(z.string()),
  templateCount: z.number().int(),
});
export type CategoryDto = z.infer<typeof CategoryDto>;

export const CategoryBody = z.object({
  name: z.string().trim().min(1, 'укажите название').max(100),
  sortOrder: z.number().int().min(-1_000_000).max(1_000_000).default(0),
  public: z.boolean().default(false),
});
export type CategoryBody = z.infer<typeof CategoryBody>;

export const TemplateAccess = z.object({
  public: z.boolean(),
  categoryId: z.uuid('неверный идентификатор').nullable(),
  groupIds: z.array(z.uuid('неверный идентификатор')).max(1000),
});
export type TemplateAccess = z.infer<typeof TemplateAccess>;

export const MembersBody = z.object({
  userIds: z.array(z.uuid('неверный идентификатор')).max(10000),
});
export type MembersBody = z.infer<typeof MembersBody>;

export const GroupIdsBody = z.object({
  groupIds: z.array(z.uuid('неверный идентификатор')).max(10000),
});
export type GroupIdsBody = z.infer<typeof GroupIdsBody>;

export const SslMode = z.enum(['disable', 'require', 'verify']);
export type SslMode = z.infer<typeof SslMode>;

const PEM_CERT = '-----BEGIN CERTIFICATE-----';

const DatasourceFields = z.object({
  name: z.string().trim().min(1),
  host: z.string().trim().min(1),
  port: z.number().int().min(1).max(65535),
  database: z.string().trim().min(1),
  username: z.string().trim().min(1),
  /** При обновлении: undefined — пароль не меняется. */
  password: z.string().optional(),
  /** Обязателен: без значения по умолчанию, чтобы старый клиент с `ssl: true` не откатился на disable. */
  sslMode: SslMode,
  /** CA-сертификат (PEM) для режима verify; null — системные корневые сертификаты. */
  sslCa: z
    .string()
    .trim()
    .nullable()
    .default(null)
    .transform((v) => (v ? v : null)),
});

export const DatasourceBody = DatasourceFields.superRefine((d, ctx) => {
  if (d.sslCa === null) return;
  if (d.sslMode !== 'verify') {
    ctx.addIssue({
      code: 'custom',
      path: ['sslCa'],
      message: 'CA-сертификат указывается только для режима «SSL с проверкой»',
    });
  } else if (!d.sslCa.includes(PEM_CERT)) {
    ctx.addIssue({
      code: 'custom',
      path: ['sslCa'],
      message: 'ожидается сертификат в формате PEM',
    });
  }
});
export type DatasourceBody = z.infer<typeof DatasourceBody>;

export const DatasourceDto = DatasourceFields.omit({ password: true }).extend({
  sslCa: z.string().nullable(),
  id: z.string(),
  createdAt: z.string(),
});
export type DatasourceDto = z.infer<typeof DatasourceDto>;

/** Категория в карточке и списке шаблонов: достаточно для группировки каталога. */
export const TemplateCategoryRef = z.object({
  id: z.string(),
  name: z.string(),
  sortOrder: z.number().int(),
});
export type TemplateCategoryRef = z.infer<typeof TemplateCategoryRef>;

export const TemplateSummary = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  fileExt: TemplateExt,
  defaultOutput: OutputFormat,
  updatedAt: z.string(),
  category: TemplateCategoryRef.nullable(),
});
export type TemplateSummary = z.infer<typeof TemplateSummary>;

export const TemplateDetails = TemplateSummary.extend({
  params: z.array(TemplateParamDto),
  outputFormats: z.array(OutputFormat),
});
export type TemplateDetails = z.infer<typeof TemplateDetails>;

export const TemplateAdminDetails = TemplateDetails.extend({
  datasourceId: z.string(),
  version: z.number(),
  queries: z.array(TemplateQuery),
  lastSaveError: z.string().nullable(),
});
export type TemplateAdminDetails = z.infer<typeof TemplateAdminDetails>;

export const CreateTemplateBody = z.object({
  name: z.string().trim().min(1),
  description: z.string().default(''),
  datasourceId: z.uuid(),
  blank: z.enum(['docx', 'xlsx']),
});
export type CreateTemplateBody = z.infer<typeof CreateTemplateBody>;

export const UpdateTemplateBody = z.object({
  name: z.string().trim().min(1).optional(),
  description: z.string().optional(),
  datasourceId: z.uuid().optional(),
  defaultOutput: OutputFormat.optional(),
});
export type UpdateTemplateBody = z.infer<typeof UpdateTemplateBody>;

export const ParamsInput = z.record(z.string(), ParamValue);
export type ParamsInput = z.infer<typeof ParamsInput>;

export const SelectOptionValue = z.object({ value: ScalarValue, label: z.string() });
export type SelectOptionValue = z.infer<typeof SelectOptionValue>;
export const ParamOptionsBody = z.object({ params: ParamsInput });
export type ParamOptionsBody = z.infer<typeof ParamOptionsBody>;
export type ParamOptionsResult = { options: SelectOptionValue[]; waitingFor?: string[] };

export const RenderBody = z.object({ params: ParamsInput, format: OutputFormat });
export type RenderBody = z.infer<typeof RenderBody>;

export const PreviewBody = z.object({ params: ParamsInput, mode: z.enum(['data', 'pdf']) });
export type PreviewBody = z.infer<typeof PreviewBody>;

export const RunQueryBody = z.object({ sql: z.string().trim().min(1), params: ParamsInput });
export type RunQueryBody = z.infer<typeof RunQueryBody>;

export const RunQueryResult = z.object({
  columns: z.array(z.string()),
  rows: z.array(z.record(z.string(), z.unknown())),
  truncated: z.boolean(),
});
export type RunQueryResult = z.infer<typeof RunQueryResult>;

export const RunDto = z.object({
  id: z.string(),
  templateId: z.string().nullable(),
  templateName: z.string().nullable(),
  templateVersion: z.number(),
  userId: z.string(),
  userLogin: z.string(),
  params: ParamsInput,
  outputFormat: OutputFormat,
  status: z.enum(['ok', 'error']),
  error: z.string().nullable(),
  fileAvailable: z.boolean(),
  durationMs: z.number(),
  createdAt: z.string(),
});
export type RunDto = z.infer<typeof RunDto>;

export const RunsQuery = z.object({
  templateId: z.uuid().optional(),
  userId: z.uuid().optional(),
  status: z.enum(['ok', 'error']).optional(),
  page: z.coerce.number().int().min(1).max(10000).default(1),
});
export type RunsQuery = z.infer<typeof RunsQuery>;

export const RUNS_PAGE_SIZE = 50;

export const RunsPage = z.object({
  items: z.array(RunDto),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
});
export type RunsPage = z.infer<typeof RunsPage>;

export const ApiError = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});
export type ApiError = z.infer<typeof ApiError>;

export const IdParams = z.object({ id: z.uuid('неверный идентификатор') });
export type IdParams = z.infer<typeof IdParams>;
