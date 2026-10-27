import { describe, expect, it } from 'vitest';
import { AssistantSettingsBody } from './assistant';
import { AssistantChatBody } from './index';

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
  describe('page.editor', () => {
    const msgs = [msg];
    const page = (editor: unknown) => ({ messages: msgs, page: { path: '/', editor } });
    it('пустой черновик допустим', () => {
      expect(AssistantChatBody.safeParse(page({ queries: [], params: [] })).success).toBe(true);
    });
    it('31 запрос — нельзя', () => {
      const queries = Array(31).fill({ key: 'q', mode: 'list', sql: 'select 1' });
      expect(AssistantChatBody.safeParse(page({ queries, params: [] })).success).toBe(false);
    });
    it('SQL длиннее 20000 — нельзя', () => {
      const queries = [{ key: 'q', mode: 'list', sql: 'x'.repeat(20_001) }];
      expect(AssistantChatBody.safeParse(page({ queries, params: [] })).success).toBe(false);
    });
    it('неверный параметр — нельзя', () => {
      const params = [{ name: '1x', label: 'x', type: 'string', required: false }];
      expect(AssistantChatBody.safeParse(page({ queries: [], params })).success).toBe(false);
    });
  });
});
