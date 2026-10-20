import type {
  OutputFormat,
  ParamType,
  ParamValue,
  PdfOptions,
  PdfPlacement,
  PdfSignaturePosition,
  QueryMode,
  Role,
  SelectOption,
  SslMode,
  TemplateChartConfig,
  TemplateExt,
} from '@carbone-reports/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  login: text('login').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').$type<Role>().notNull(),
  blocked: boolean('blocked').notNull().default(false),
  sessionVersion: integer('session_version').notNull().default(0),
  createdAt: createdAt(),
});

export const datasources = pgTable('datasources', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  host: text('host').notNull(),
  port: integer('port').notNull(),
  database: text('database').notNull(),
  username: text('username').notNull(),
  passwordEnc: text('password_enc').notNull(),
  sslMode: text('ssl_mode').$type<SslMode>().notNull().default('disable'),
  sslCa: text('ssl_ca'),
  createdAt: createdAt(),
});

export const groups = pgTable(
  'groups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('groups_name_lower_uq').on(sql`lower(${t.name})`)],
);

export const userGroups = pgTable(
  'user_groups',
  {
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.groupId] }),
    index('user_groups_group_id_idx').on(t.groupId),
  ],
);

export const categories = pgTable(
  'categories',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    public: boolean('public').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('categories_name_lower_uq').on(sql`lower(${t.name})`)],
);

export const categoryGroups = pgTable(
  'category_groups',
  {
    categoryId: uuid('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.categoryId, t.groupId] }),
    index('category_groups_group_id_idx').on(t.groupId),
  ],
);

export const templates = pgTable('templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  datasourceId: uuid('datasource_id')
    .notNull()
    .references(() => datasources.id, { onDelete: 'restrict' }),
  fileExt: text('file_ext').$type<TemplateExt>().notNull(),
  filePath: text('file_path').notNull(),
  version: integer('version').notNull().default(1),
  docKey: text('doc_key').notNull(),
  defaultOutput: text('default_output').$type<OutputFormat>().notNull().default('pdf'),
  lastSaveError: text('last_save_error'),
  lastSaveErrorAt: timestamp('last_save_error_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  categoryId: uuid('category_id').references(() => categories.id, { onDelete: 'set null' }),
  public: boolean('public').notNull().default(false),
  /** Настройки PDF (§36.1); {} — без настроек. */
  pdfOptions: jsonb('pdf_options').$type<Partial<PdfOptions>>().notNull().default({}),
  /** Пароль на открытие PDF (§37.1), encryptSecret; null — без пароля. */
  pdfPasswordEnc: text('pdf_password_enc'),
});

/** Блокировка редактирования шаблона (§38.1): одна строка на шаблон; просроченная равна отсутствующей. */
export const templateEditLocks = pgTable('template_edit_locks', {
  templateId: uuid('template_id')
    .primaryKey()
    .references(() => templates.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** Номер вкладки «Документ» (UUID из браузера). */
  holder: text('holder').notNull(),
  acquiredAt: timestamp('acquired_at', { withTimezone: true }).notNull(),
  heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }).notNull(),
});

export const templateGroups = pgTable(
  'template_groups',
  {
    templateId: uuid('template_id')
      .notNull()
      .references(() => templates.id, { onDelete: 'cascade' }),
    groupId: uuid('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.templateId, t.groupId] }),
    index('template_groups_group_id_idx').on(t.groupId),
  ],
);

export const templateQueries = pgTable(
  'template_queries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    templateId: uuid('template_id')
      .notNull()
      .references(() => templates.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    sql: text('sql').notNull(),
    mode: text('mode').$type<QueryMode>().notNull(),
    sortOrder: integer('sort_order').notNull(),
  },
  (t) => [unique().on(t.templateId, t.key)],
);

export const templateParams = pgTable(
  'template_params',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    templateId: uuid('template_id')
      .notNull()
      .references(() => templates.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    label: text('label').notNull(),
    type: text('type').$type<ParamType>().notNull(),
    required: boolean('required').notNull(),
    defaultValue: jsonb('default_value').$type<ParamValue>(),
    options: jsonb('options').$type<SelectOption[] | null>(),
    sql: text('sql'),
    multiple: boolean('multiple').notNull().default(false),
    sortOrder: integer('sort_order').notNull(),
  },
  (t) => [unique().on(t.templateId, t.name)],
);

/** Графики конструктора (§35.3): настройки без ключа — в config. */
export const templateCharts = pgTable(
  'template_charts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    templateId: uuid('template_id')
      .notNull()
      .references(() => templates.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    sortOrder: integer('sort_order').notNull(),
    config: jsonb('config').$type<TemplateChartConfig>().notNull(),
  },
  (t) => [unique().on(t.templateId, t.key)],
);

export const templateAttachments = pgTable('template_attachments', {
  id: uuid('id').primaryKey().defaultRandom(),
  templateId: uuid('template_id')
    .notNull()
    .references(() => templates.id, { onDelete: 'cascade' }),
  placement: text('placement').$type<PdfPlacement>().notNull(),
  sortOrder: integer('sort_order').notNull(),
  name: text('name').notNull(),
  filePath: text('file_path').notNull(),
  size: integer('size').notNull(),
  pages: integer('pages').notNull(),
  pdfa: boolean('pdfa').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
export type TemplateAttachmentRow = typeof templateAttachments.$inferSelect;

export const reportRuns = pgTable('report_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  templateId: uuid('template_id').references(() => templates.id, { onDelete: 'set null' }),
  templateName: text('template_name').notNull(),
  templateVersion: integer('template_version').notNull(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  params: jsonb('params').$type<Record<string, ParamValue>>().notNull(),
  /** Формат старого запуска (snapshot = false); у новых — null, файлы в report_run_files. */
  outputFormat: text('output_format').$type<OutputFormat>(),
  status: text('status').$type<'ok' | 'error'>().notNull(),
  error: text('error'),
  /** Старый запуск — его единственный файл; запуск со снимком — копия шаблона `reports/<id>/template.<ext>`. */
  filePath: text('file_path'),
  fileDeleted: boolean('file_deleted').notNull().default(false),
  /** Запуск со снимком (§24.2): данные и копия шаблона в `reports/<id>/`. */
  snapshot: boolean('snapshot').notNull().default(false),
  /** Положение штампа, если подпись разрешена в снимке запуска (§39.2, R16); null — подписать нельзя. */
  signaturePosition: text('signature_position').$type<PdfSignaturePosition>(),
  durationMs: integer('duration_ms').notNull(),
  createdAt: createdAt(),
});

/** Собранные из снимка файлы запуска (§24.3). */
export const reportRunFiles = pgTable(
  'report_run_files',
  {
    runId: uuid('run_id')
      .notNull()
      .references(() => reportRuns.id, { onDelete: 'cascade' }),
    format: text('format').$type<OutputFormat>().notNull(),
    filePath: text('file_path').notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.runId, t.format] })],
);

/** Сертификат подписи пользователя (§39.1): один на пользователя; .p12 — encryptSecret(base64). */
export const userCertificates = pgTable('user_certificates', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  p12Enc: text('p12_enc').notNull(),
  subjectCn: text('subject_cn').notNull(),
  issuer: text('issuer').notNull(),
  serial: text('serial').notNull(),
  fingerprint: text('fingerprint').notNull(),
  keyAlg: text('key_alg').notNull(),
  notBefore: timestamp('not_before', { withTimezone: true }).notNull(),
  notAfter: timestamp('not_after', { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});
export type UserCertificateRow = typeof userCertificates.$inferSelect;

/** Подпись запуска (§39.3): одна на запуск; файл — reports/<runId>/out.signed.pdf. */
export const reportRunSignatures = pgTable('report_run_signatures', {
  runId: uuid('run_id')
    .primaryKey()
    .references(() => reportRuns.id, { onDelete: 'cascade' }),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  signerCn: text('signer_cn').notNull(),
  fingerprint: text('fingerprint').notNull(),
  signedAt: timestamp('signed_at', { withTimezone: true }).notNull(),
  timestamped: boolean('timestamped').notNull(),
  filePath: text('file_path').notNull(),
});
export type RunSignatureRow = typeof reportRunSignatures.$inferSelect;

export type UserRow = typeof users.$inferSelect;
export type DatasourceRow = typeof datasources.$inferSelect;
export type TemplateRow = typeof templates.$inferSelect;
export type TemplateQueryRow = typeof templateQueries.$inferSelect;
export type TemplateParamRow = typeof templateParams.$inferSelect;
export type TemplateChartRow = typeof templateCharts.$inferSelect;
export type RunRow = typeof reportRuns.$inferSelect;
export type RunFileRow = typeof reportRunFiles.$inferSelect;
export type GroupRow = typeof groups.$inferSelect;
export type CategoryRow = typeof categories.$inferSelect;
