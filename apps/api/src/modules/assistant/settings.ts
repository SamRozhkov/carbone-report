// Настройки ИИ-ассистента (§50.2): одна строка; ключ — зашифрованным, наружу не отдаётся.
import type { AssistantSettingsBody, AssistantSettingsDto } from '@carbone-reports/shared';
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { assistantSettings } from '../../db/schema';
import { decryptSecret, encryptSecret } from '../../lib/crypto';

export interface AssistantSettings {
  enabled: boolean;
  baseUrl: string;
  model: string;
  apiKey: string | null;
  extraInstructions: string;
}

const DEFAULTS: AssistantSettings = {
  enabled: false,
  baseUrl: '',
  model: '',
  apiKey: null,
  extraInstructions: '',
};

async function row(db: Db) {
  const [r] = await db.select().from(assistantSettings).where(eq(assistantSettings.id, 1));
  return r;
}

export async function loadAssistantSettings(db: Db, key: Buffer): Promise<AssistantSettings> {
  const r = await row(db);
  if (!r) return { ...DEFAULTS };
  return {
    enabled: r.enabled,
    baseUrl: r.baseUrl,
    model: r.model,
    apiKey: r.apiKeyEnc ? decryptSecret(r.apiKeyEnc, key) : null,
    extraInstructions: r.extraInstructions,
  };
}

export async function isAssistantEnabled(db: Db): Promise<boolean> {
  return (await row(db))?.enabled ?? false;
}

export async function saveAssistantSettings(
  db: Db,
  key: Buffer,
  body: AssistantSettingsBody,
): Promise<void> {
  const values = {
    enabled: body.enabled,
    baseUrl: body.baseUrl,
    model: body.model,
    extraInstructions: body.extraInstructions,
    updatedAt: new Date(),
    // Нет поля — ключ не меняется; null или пустая строка — удалить.
    ...(body.apiKey === undefined
      ? {}
      : { apiKeyEnc: body.apiKey ? encryptSecret(body.apiKey, key) : null }),
  };
  await db
    .insert(assistantSettings)
    .values({ id: 1, ...values })
    .onConflictDoUpdate({ target: assistantSettings.id, set: values });
}

export const toSettingsDto = (s: AssistantSettings): AssistantSettingsDto => ({
  enabled: s.enabled,
  baseUrl: s.baseUrl,
  model: s.model,
  hasApiKey: s.apiKey !== null,
  extraInstructions: s.extraInstructions,
});
