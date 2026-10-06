import type {
  OutputFormat,
  ParamType,
  ParamValue,
  QueryMode,
  Role,
  SelectOption,
  SslMode,
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
export type GroupRow = typeof groups.$inferSelect;
export type CategoryRow = typeof categories.$inferSelect;
