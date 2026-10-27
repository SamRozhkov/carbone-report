// ИИ-ассистент (§50): настройки подключения к модели, чат, карточка запуска.
import { z } from 'zod';
import type { OutputFormat, ParamValue } from './index';

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

export const AssistantChatBody = z.object({
  messages: z.array(ChatTurn).min(1).max(20),
  page: z.object({ path: z.string().max(500), reportId: z.string().max(100).optional() }),
});
export type AssistantChatBody = z.infer<typeof AssistantChatBody>;

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

export interface AssistantChatReply {
  reply: string;
  card: RunCard | null;
}
