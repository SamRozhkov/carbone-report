import { z } from 'zod';

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

export const ParamType = z.enum(['string', 'number', 'date', 'boolean', 'select']);
export type ParamType = z.infer<typeof ParamType>;

export const SelectOption = z.object({ value: z.string().min(1), label: z.string().min(1) });
export type SelectOption = z.infer<typeof SelectOption>;

export const ParamValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export type ParamValue = z.infer<typeof ParamValue>;

export const TemplateParam = z
  .object({
    name: z.string().regex(IDENT_RE, 'имя: латиница, цифры и _').refine(notReserved, 'зарезервированное имя'),
    label: z.string().min(1),
    type: ParamType,
    required: z.boolean(),
    defaultValue: ParamValue,
    options: z.array(SelectOption).min(1).nullable(),
  })
  .refine((p) => p.type !== 'select' || (p.options && p.options.length > 0), {
    message: 'для select нужен хотя бы один вариант',
    path: ['options'],
  });
export type TemplateParam = z.infer<typeof TemplateParam>;

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

export const LoginBody = z.object({ login: z.string().min(1), password: z.string().min(1).max(1024) });
export type LoginBody = z.infer<typeof LoginBody>;

export const UserDto = z.object({
  id: z.string(),
  login: z.string(),
  role: Role,
  blocked: z.boolean(),
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

export const DatasourceBody = z.object({
  name: z.string().trim().min(1),
  host: z.string().trim().min(1),
  port: z.number().int().min(1).max(65535),
  database: z.string().trim().min(1),
  username: z.string().trim().min(1),
  /** При обновлении: undefined — пароль не меняется. */
  password: z.string().optional(),
  ssl: z.boolean(),
});
export type DatasourceBody = z.infer<typeof DatasourceBody>;

export const DatasourceDto = DatasourceBody.omit({ password: true }).extend({
  id: z.string(),
  createdAt: z.string(),
});
export type DatasourceDto = z.infer<typeof DatasourceDto>;

export const TemplateSummary = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  fileExt: TemplateExt,
  defaultOutput: OutputFormat,
  updatedAt: z.string(),
});
export type TemplateSummary = z.infer<typeof TemplateSummary>;

export const TemplateDetails = TemplateSummary.extend({
  params: z.array(TemplateParam),
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

export const ApiError = z.object({
  error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }),
});
export type ApiError = z.infer<typeof ApiError>;

export const IdParams = z.object({ id: z.uuid('неверный идентификатор') });
export type IdParams = z.infer<typeof IdParams>;
