import type {
  OutputFormat,
  ParamType,
  ParamValue,
  QueryMode,
  Role,
  SelectOption,
  TemplateExt,
} from '@carbone-reports/shared';
import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
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
  ssl: boolean('ssl').notNull().default(false),
  createdAt: createdAt(),
});

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
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
});

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
    sortOrder: integer('sort_order').notNull(),
  },
  (t) => [unique().on(t.templateId, t.name)],
);

export const reportRuns = pgTable('report_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  templateId: uuid('template_id').references(() => templates.id, { onDelete: 'set null' }),
  templateName: text('template_name').notNull(),
  templateVersion: integer('template_version').notNull(),
  userId: uuid('user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  params: jsonb('params').$type<Record<string, ParamValue>>().notNull(),
  outputFormat: text('output_format').$type<OutputFormat>().notNull(),
  status: text('status').$type<'ok' | 'error'>().notNull(),
  error: text('error'),
  filePath: text('file_path'),
  fileDeleted: boolean('file_deleted').notNull().default(false),
  durationMs: integer('duration_ms').notNull(),
  createdAt: createdAt(),
});

export type UserRow = typeof users.$inferSelect;
export type DatasourceRow = typeof datasources.$inferSelect;
export type TemplateRow = typeof templates.$inferSelect;
export type TemplateQueryRow = typeof templateQueries.$inferSelect;
export type TemplateParamRow = typeof templateParams.$inferSelect;
export type RunRow = typeof reportRuns.$inferSelect;
