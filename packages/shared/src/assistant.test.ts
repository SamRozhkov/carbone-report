import { describe, expect, it } from 'vitest';
import { AssistantChatBody, AssistantSettingsBody } from './assistant';

const base = { enabled: false, baseUrl: '', model: '', extraInstructions: '' };

describe('AssistantSettingsBody', () => {
  it('выключенный ассистент без адреса и модели — допустим', () => {
    expect(AssistantSettingsBody.safeParse(base).success).toBe(true);
  });
  it('включение требует адрес и модель', () => {
    const r = AssistantSettingsBody.safeParse({ ...base, enabled: true });
    expect(r.success).toBe(false);
    expect(r.error!.issues.map((i) => i.path[0]).sort()).toEqual(['baseUrl', 'model']);
  });
  it('адрес только http(s)', () => {
    const r = AssistantSettingsBody.safeParse({ ...base, baseUrl: 'ftp://x' });
    expect(r.success).toBe(false);
    expect(
      AssistantSettingsBody.safeParse({
        ...base,
        enabled: true,
        baseUrl: 'http://ollama:11434/v1',
        model: 'qwen3',
      }).success,
    ).toBe(true);
  });
  it('доп. инструкции не длиннее 2000', () => {
    expect(
      AssistantSettingsBody.safeParse({ ...base, extraInstructions: 'x'.repeat(2001) }).success,
    ).toBe(false);
  });
});

describe('AssistantChatBody', () => {
  const msg = { role: 'user' as const, content: 'счёт' };
  it('1–20 сообщений', () => {
    expect(AssistantChatBody.safeParse({ messages: [], page: { path: '/' } }).success).toBe(false);
    expect(
      AssistantChatBody.safeParse({ messages: Array(21).fill(msg), page: { path: '/' } }).success,
    ).toBe(false);
    expect(AssistantChatBody.safeParse({ messages: [msg], page: { path: '/' } }).success).toBe(
      true,
    );
  });
  it('сообщение не длиннее 4000', () => {
    const long = { role: 'user', content: 'x'.repeat(4001) };
    expect(AssistantChatBody.safeParse({ messages: [long], page: { path: '/' } }).success).toBe(
      false,
    );
  });
});
