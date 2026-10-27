// ИИ-ассистент (§50): настройки подключения к модели, чат, карточка запуска.
import { z } from 'zod';
import type { OutputFormat, ParamValue, QueryMode, TemplateParam } from './index';

const httpUrl = (v: string) => {
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
};

/** PUT /api/admin/assistant. apiKey: строка — заменить, null — удалить, нет поля — не менять. */
export const AssistantSettingsBody = z
  .object({
    enabled: z.boolean(),
    baseUrl: z.string().trim().max(500),
    model: z.string().trim().max(200),
    apiKey: z.string().max(4000).nullable().optional(),
    extraInstructions: z.string().max(2000),
  })
  .superRefine((b, ctx) => {
    if (b.baseUrl !== '' && !httpUrl(b.baseUrl))
      ctx.addIssue({ code: 'custom', path: ['baseUrl'], message: 'v:assistantUrl' });
    if (b.enabled && b.baseUrl === '')
      ctx.addIssue({ code: 'custom', path: ['baseUrl'], message: 'v:assistantUrl' });
    if (b.enabled && b.model === '')
      ctx.addIssue({ code: 'custom', path: ['model'], message: 'v:assistantModel' });
  });
export type AssistantSettingsBody = z.infer<typeof AssistantSettingsBody>;

export interface AssistantSettingsDto {
  enabled: boolean;
  baseUrl: string;
  model: string;
  /** Ключ задан; сам ключ не возвращается никогда. */
  hasApiKey: boolean;
  extraInstructions: string;
}

/** POST /api/admin/assistant/test: несохранённые значения формы; без apiKey — сохранённый ключ. */
export const AssistantTestBody = z.object({
  baseUrl: z.string().trim().min(1, 'v:assistantUrl').max(500).refine(httpUrl, 'v:assistantUrl'),
  model: z.string().trim().min(1, 'v:assistantModel').max(200),
  apiKey: z.string().max(4000).nullable().optional(),
});
export type AssistantTestBody = z.infer<typeof AssistantTestBody>;

export type AssistantErrorCode = 'auth' | 'model' | 'unavailable' | 'limit';
export type AssistantTestResult =
  { ok: true } | { ok: false; code: AssistantErrorCode; message: string };

export const ChatTurn = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(4000),
});
export type ChatTurn = z.infer<typeof ChatTurn>;

// AssistantChatBody и EditorDraft объявлены в index.ts рядом с TemplateParam: значение-импорт
// из './index' здесь дал бы цикл загрузки (index реэкспортирует этот файл).
export const MAX_CARDS = 5;

export interface RunCardItem {
  label: string;
  value: string;
}

/** Предложенный ассистентом запуск (§50.3): запускает пользователь кнопкой. */
export interface RunCard {
  reportId: string;
  reportName: string;
  params: Record<string, ParamValue>;
  display: RunCardItem[];
  outputFormats: OutputFormat[];
  defaultOutput: OutputFormat;
}

export interface QueryCheckColumn {
  name: string;
  type: string;
}
export type QueryCheck = { ok: true; columns: QueryCheckColumn[] } | { ok: false; error: string };

/** POST /api/templates/:id/queries/check — проверка SQL автора без строк (§51.2). */
export const CheckQueryBody = z.object({ sql: z.string().trim().min(1).max(20_000) });
export type CheckQueryBody = z.infer<typeof CheckQueryBody>;

/** Схема источника для авторов (§51.2): только системный каталог. */
export type RelationKind = 'table' | 'view' | 'matview' | 'foreign';
export interface SchemaTable {
  schema: string;
  name: string;
  kind: RelationKind;
  comment: string | null;
}
export interface SchemaTableList {
  total: number;
  tables: SchemaTable[];
}
export interface SchemaColumn {
  name: string;
  type: string;
  notNull: boolean;
  comment: string | null;
}
export interface SchemaForeignKey {
  columns: string[];
  references: { schema: string; table: string; columns: string[] };
}
export interface SchemaTableDetails extends SchemaTable {
  columns: SchemaColumn[];
  primaryKey: string[];
  foreignKeys: SchemaForeignKey[];
}

/** Карточка в ответе ассистента: запуск (§50.3) или предложение автору шаблона (§51). */
export type Card =
  | ({ type: 'run' } & RunCard)
  | {
      type: 'query';
      templateId: string;
      templateName: string;
      key: string;
      mode: QueryMode;
      sql: string;
      check: QueryCheck;
    }
  | { type: 'param'; templateId: string; templateName: string; param: TemplateParam }
  | { type: 'tags'; templateId: string; templateName: string; text: string; explanation: string };

export interface AssistantChatReply {
  reply: string;
  cards: Card[];
}
