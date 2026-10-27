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
    impl ??
      (async (name) =>
        name === 'propose_run'
          ? { card: { type: 'run' as const, ...card } }
          : { result: { ok: name } }),
  ),
});
const base = { system: 'sys', history: [{ role: 'user' as const, content: 'счёт' }] };

describe('runAgent', () => {
  it('инструменты по цепочке, результат уходит модели, текст — ответ', async () => {
    const llm = script(call('list_reports', '{}'), text('Нашёл'));
    const t = tools();
    expect(await runAgent({ llm, tools: t, ...base })).toEqual({ reply: 'Нашёл', cards: [] });
    const second = llm.mock.calls[1]![0].messages;
    expect(second[0]).toEqual({ role: 'system', content: 'sys' });
    expect(second.at(-1)).toEqual({
      role: 'tool',
      tool_call_id: 'list_reports',
      content: JSON.stringify({ ok: 'list_reports' }),
    });
  });

  it('propose_* не завершают ответ: карточки копятся, ответ — текстом', async () => {
    const llm = script(
      {
        content: null,
        toolCalls: [
          { id: 'a', type: 'function', function: { name: 'propose_run', arguments: '{}' } },
          { id: 'b', type: 'function', function: { name: 'propose_run', arguments: '{}' } },
        ],
      },
      text('Вот два варианта'),
    );
    const r = await runAgent({ llm, tools: tools(), ...base });
    expect(r.reply).toBe('Вот два варианта');
    expect(r.cards).toHaveLength(2);
    expect(llm.mock.calls[1]![0].messages.at(-1)).toEqual({
      role: 'tool',
      tool_call_id: 'b',
      content: '{"ok":true}',
    });
  });

  it('шестая карточка — ошибка модели', async () => {
    const six = Array.from({ length: 6 }, (_, i) => ({
      id: `c${i}`,
      type: 'function' as const,
      function: { name: 'propose_run', arguments: '{}' },
    }));
    const llm = script({ content: null, toolCalls: six }, text('ok'));
    const r = await runAgent({ llm, tools: tools(), ...base });
    expect(r.cards).toHaveLength(5);
    expect(String(llm.mock.calls[1]![0].messages.at(-1)!.content)).toContain('too many cards');
  });

  it('пустой текст при карточках — допустим', async () => {
    const llm = script(call('propose_run', '{}'), text(''));
    expect((await runAgent({ llm, tools: tools(), ...base })).cards).toHaveLength(1);
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

  it('лимит шагов после карточек — карточки без текста, причина в журнал', async () => {
    const llm = vi
      .fn<LlmClient>(async () => call('list_reports', '{}'))
      .mockResolvedValueOnce(call('propose_run', '{}'));
    const onLimit = vi.fn();
    const r = await runAgent({ llm, tools: tools(), ...base, maxToolCalls: 3, onLimit });
    expect(r).toEqual({ reply: '', cards: [expect.objectContaining({ type: 'run' })] });
    expect(onLimit).toHaveBeenCalledWith('шаги');
  });

  it('срок истёк после карточек — карточки без текста', async () => {
    const llm = vi
      .fn<LlmClient>(
        (_r, signal) =>
          new Promise((_res, rej) =>
            signal!.addEventListener('abort', () => rej(new Error('aborted'))),
          ),
      )
      .mockResolvedValueOnce(call('propose_run', '{}'));
    const onLimit = vi.fn();
    const r = await runAgent({ llm, tools: tools(), ...base, deadlineMs: 30, onLimit });
    expect(r.cards).toHaveLength(1);
    expect(r.reply).toBe('');
    expect(onLimit).toHaveBeenCalledWith('срок');
  });

  it('карточка с result — модели уходит result', async () => {
    const llm = script(call('propose_query', '{}'), text('ok'));
    const t = tools(async () => ({
      card: { type: 'run' as const, ...card },
      result: { ok: true, check: { ok: false, error: 'e' } },
    }));
    await runAgent({ llm, tools: t, ...base });
    expect(llm.mock.calls[1]![0].messages.at(-1)!.content).toBe(
      JSON.stringify({ ok: true, check: { ok: false, error: 'e' } }),
    );
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

  it('авторский раздел — только в авторском режиме', () => {
    const page = { path: '/admin/templates/t1' };
    const s = systemPrompt({
      locale: 'ru',
      today: 'x',
      extra: 'admin note',
      page,
      author: { templateName: 'Счёт' },
    });
    expect(s).toContain('check_sql');
    expect(s).toContain('d.<key>[i]');
    expect(s).toContain('formatC');
    expect(s).toContain('«Счёт»');
    expect(s).toContain('not Handlebars');
    expect(s).toContain('| {d.<key>[i+1].name} |  |');
    expect(s).toContain('propose_table');
    // Инструкции администратора — по-прежнему в конце.
    expect(s.endsWith('Administrator instructions:\nadmin note')).toBe(true);
    expect(systemPrompt({ locale: 'ru', today: 'x', extra: '', page })).not.toContain('check_sql');
  });
});
