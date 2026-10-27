import { describe, expect, it, vi } from 'vitest';
import { AgentLimitError, runAgent } from './agent';
import type { LlmClient, LlmResponse } from './llm';
import { systemPrompt } from './prompt';
import type { AgentTools } from './tools';

const call = (name: string, args: string, id = name): LlmResponse => ({
  content: null,
  toolCalls: [{ id, type: 'function', function: { name, arguments: args } }],
});
const text = (content: string): LlmResponse => ({ content, toolCalls: [] });
const script = (...steps: LlmResponse[]) => {
  const llm = vi.fn<LlmClient>(async () => steps.shift() ?? text('конец'));
  return llm;
};
const card = {
  reportId: 'r',
  reportName: 'Счёт',
  params: {},
  display: [],
  outputFormats: ['pdf' as const],
  defaultOutput: 'pdf' as const,
};
const tools = (impl?: AgentTools['run']): AgentTools => ({
  specs: [],
  run: vi.fn(
    impl ?? (async (name) => (name === 'propose_run' ? { card } : { result: { ok: name } })),
  ),
});
const base = { system: 'sys', history: [{ role: 'user' as const, content: 'счёт' }] };

describe('runAgent', () => {
  it('инструменты по цепочке, результат уходит модели, текст — ответ', async () => {
    const llm = script(call('list_reports', '{}'), text('Нашёл'));
    const t = tools();
    expect(await runAgent({ llm, tools: t, ...base })).toEqual({ reply: 'Нашёл', card: null });
    const second = llm.mock.calls[1]![0].messages;
    expect(second[0]).toEqual({ role: 'system', content: 'sys' });
    expect(second.at(-1)).toEqual({
      role: 'tool',
      tool_call_id: 'list_reports',
      content: JSON.stringify({ ok: 'list_reports' }),
    });
  });

  it('propose_run завершает ответ карточкой', async () => {
    const llm = script({
      ...call('propose_run', '{"reportId":"r","params":{}}'),
      content: 'Готово',
    });
    expect(await runAgent({ llm, tools: tools(), ...base })).toEqual({ reply: 'Готово', card });
    expect(llm).toHaveBeenCalledTimes(1);
  });

  it('неверный JSON аргументов — ошибка модели, цикл продолжается', async () => {
    const llm = script(call('get_report_form', '{oops'), text('Уточните'));
    const t = tools();
    expect((await runAgent({ llm, tools: t, ...base })).reply).toBe('Уточните');
    expect(t.run).not.toHaveBeenCalled();
    expect(String(llm.mock.calls[1]![0].messages.at(-1)!.content)).toContain('invalid JSON');
  });

  it('исключение инструмента — общая ошибка модели (без текста исключения), а не 500', async () => {
    const llm = script(call('list_reports', '{}'), text('ok'));
    const t = tools(async () => {
      throw new Error('db down');
    });
    const onToolError = vi.fn();
    expect((await runAgent({ llm, tools: t, ...base, onToolError })).reply).toBe('ok');
    const content = String(llm.mock.calls[1]![0].messages.at(-1)!.content);
    expect(content).toContain('tool failed');
    // Граница данных: текст исключения (таблицы, хосты) в модель не уходит.
    expect(content).not.toContain('db down');
    expect(onToolError).toHaveBeenCalledWith('list_reports', expect.any(Error));
  });

  it('больше maxToolCalls вызовов — AgentLimitError', async () => {
    const llm = vi.fn<LlmClient>(async () => call('list_reports', '{}'));
    await expect(
      runAgent({ llm, tools: tools(), ...base, maxToolCalls: 3 }),
    ).rejects.toBeInstanceOf(AgentLimitError);
    expect(llm).toHaveBeenCalledTimes(4);
  });

  it('пустой финальный ответ — AgentLimitError', async () => {
    await expect(
      runAgent({ llm: script(text('  ')), tools: tools(), ...base }),
    ).rejects.toBeInstanceOf(AgentLimitError);
  });

  it('срок истёк — AgentLimitError', async () => {
    const llm = vi.fn<LlmClient>(
      (_r, signal) =>
        new Promise((_res, rej) =>
          signal!.addEventListener('abort', () => rej(new Error('aborted'))),
        ),
    );
    await expect(runAgent({ llm, tools: tools(), ...base, deadlineMs: 30 })).rejects.toBeInstanceOf(
      AgentLimitError,
    );
  });
});

describe('systemPrompt', () => {
  it('язык, дата, страница, инструкции администратора', () => {
    const s = systemPrompt({
      locale: 'de',
      today: '2026-10-27',
      extra: ' Продажи — «Коммерция» ',
      page: { path: '/reports/r1', reportId: 'r1' },
    });
    expect(s).toContain('in Deutsch');
    expect(s).toContain('Today is 2026-10-27');
    expect(s).toContain('the open report id is r1');
    expect(s.endsWith('Administrator instructions:\nПродажи — «Коммерция»')).toBe(true);
    expect(
      systemPrompt({ locale: 'ru', today: 'x', extra: '', page: { path: '/' } }),
    ).not.toContain('Administrator');
  });
});
