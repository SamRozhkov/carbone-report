import type { Card, EditorDraft } from '@carbone-reports/shared';
import { renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi, renderWithProviders, wrapper } from '../../test/utils';
import { AssistantBridgeProvider, useAssistantBridge, type TabRegistration } from './bridge';
import { AssistantPanel } from './AssistantPanel';
import { ASSISTANT_KEY, toHistory } from './storage';
import { useAssistantChat, useCardText } from './useAssistantChat';

const param = {
  name: 'from',
  label: 'С даты',
  type: 'date' as const,
  required: true,
  defaultValue: null,
  options: null,
  sql: null,
  multiple: false,
};
const saved: EditorDraft = {
  queries: [{ key: 'items', mode: 'single', sql: 'select 0' }],
  params: [param],
};
const queryCard = (
  key = 'items',
  templateId = 't1',
  check?: Extract<Card, { type: 'query' }>['check'],
) =>
  ({
    type: 'query',
    templateId,
    key,
    mode: 'list',
    sql: 'select 1',
    check: check ?? {
      ok: true,
      columns: [
        { name: 'id', type: 'integer' },
        { name: 'name', type: 'text' },
      ],
    },
  }) as Card;

function Registrar({ templateId, dirtyTab }: { templateId: string; dirtyTab?: boolean }) {
  const { registerEditor, registerTab } = useAssistantBridge();
  useEffect(() => {
    const off = registerEditor({
      templateId,
      templateName: 'Счёт',
      saved: () => saved,
      openTab: vi.fn(),
    });
    let offTab = () => {};
    if (dirtyTab) {
      const tab: TabRegistration = {
        kind: 'param',
        draft: () => saved.params,
        apply: vi.fn(),
        dirty: () => true,
      };
      offTab = registerTab(tab);
    }
    return () => {
      offTab();
      off();
    };
  }, [registerEditor, registerTab, templateId, dirtyTab]);
  return null;
}

function Panel({ cards }: { cards: Card[] }) {
  const chat = useAssistantChat();
  // Карточки кладутся в ленту напрямую через ответ чата в тестах ниже.
  return <AssistantPanel chat={chat} key={cards.length} />;
}

function setup(
  cards: Card[],
  editor: { templateId: string; dirtyTab?: boolean } | null = { templateId: 't1' },
) {
  sessionStorage.clear();
  sessionStorage.setItem(
    ASSISTANT_KEY,
    JSON.stringify({ open: true, messages: [{ role: 'assistant', content: 'Вот', cards }] }),
  );
  return renderWithProviders(
    <AssistantBridgeProvider>
      {editor && <Registrar {...editor} />}
      <Panel cards={cards} />
    </AssistantBridgeProvider>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe('карточки ассистента', () => {
  it('запрос: ключ занят — «Заменить», результат проверки виден', async () => {
    setup([queryCard('items')]);
    expect(await screen.findByRole('button', { name: 'Заменить запрос «items»' })).toBeEnabled();
    expect(screen.getByText('Проверено: id (integer), name (text)')).toBeInTheDocument();
    expect(screen.getByText('select 1')).toBeInTheDocument();
  });

  it('запрос: ключа нет — «Добавить запрос»', async () => {
    setup([queryCard('rows')]);
    expect(await screen.findByRole('button', { name: 'Добавить запрос' })).toBeEnabled();
  });

  it('ошибка проверки показывается, кнопка применения остаётся', async () => {
    setup([queryCard('rows', 't1', { ok: false, error: 'нет таблицы' })]);
    expect(await screen.findByText('Ошибка проверки: нет таблицы')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Добавить запрос' })).toBeEnabled();
  });

  it('несохранённые правки на другой вкладке — карточка в очереди, тост об этом', async () => {
    setup([queryCard('rows')], { templateId: 't1', dirtyTab: true });
    await userEvent.click(await screen.findByRole('button', { name: 'Добавить запрос' }));
    expect(
      await screen.findByText('Изменение применится, когда вы откроете вкладку «Данные»'),
    ).toBeInTheDocument();
  });

  it('карточка чужого шаблона: применение неактивно, подсказка, «Копировать» работает', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    setup([queryCard('items', 'other')]);
    const btn = await screen.findByRole('button', { name: 'Заменить запрос «items»' });
    expect(btn).toBeDisabled();
    expect(screen.getByText('Откройте шаблон, чтобы применить')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Копировать' }));
    expect(writeText).toHaveBeenCalledWith('select 1');
    expect(await screen.findByText('Скопировано')).toBeInTheDocument();
  });

  it('параметр: «Создать параметр» / «Обновить «from»»', async () => {
    setup([
      { type: 'param', templateId: 't1', param: { ...param, name: 'to', label: 'По' } },
      { type: 'param', templateId: 't1', param },
    ]);
    expect(await screen.findByRole('button', { name: 'Создать параметр' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Обновить «from»' })).toBeEnabled();
    expect(screen.getAllByText(/Дата/).length).toBeGreaterThan(0);
  });

  it('фрагмент: моноширинный текст, «Копировать», подсказка Ctrl+V', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    setup([
      { type: 'tags', templateId: 't1', text: '{d.items[i].name}', explanation: 'Строка таблицы' },
    ]);
    const code = await screen.findByText('{d.items[i].name}');
    expect(code.tagName).toBe('PRE');
    expect(code).toHaveClass('cr-assistant__code');
    expect(screen.getByText('Вставьте в документ: Ctrl+V')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Копировать' }));
    expect(writeText).toHaveBeenCalledWith('{d.items[i].name}');
  });

  it('пустое состояние в редакторе — подсказки автора', async () => {
    sessionStorage.clear();
    sessionStorage.setItem(ASSISTANT_KEY, JSON.stringify({ open: true, messages: [] }));
    renderWithProviders(
      <AssistantBridgeProvider>
        <Registrar templateId="t1" />
        <Panel cards={[]} />
      </AssistantBridgeProvider>,
    );
    expect(
      await screen.findByRole('button', { name: 'Какие таблицы есть в базе?' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Какие отчёты мне доступны?' })).toBeNull();
  });

  it('в историю карточки уходят текстом', () => {
    const { result } = renderHook(() => useCardText(), { wrapper });
    const history = toHistory(
      [{ role: 'assistant', content: '', cards: [queryCard('items')] }],
      result.current,
    );
    expect(history[0]?.content).toBe('Предложен запрос «items» (список строк): select 1');
    expect(result.current({ type: 'param', templateId: 't1', param })).toBe(
      'Предложен параметр «from» (date)',
    );
    expect(result.current({ type: 'tags', templateId: 't1', text: '{d.x}', explanation: '' })).toBe(
      'Предложен фрагмент документа: {d.x}',
    );
  });
});

describe('запрос чата из редактора', () => {
  const send = async (editor: { templateId: string } | null) => {
    const { calls } = mockApi([
      {
        method: 'POST',
        path: '/api/assistant/chat',
        body: { reply: 'ок', cards: [] },
      },
    ]);
    sessionStorage.clear();
    sessionStorage.setItem(ASSISTANT_KEY, JSON.stringify({ open: true, messages: [] }));
    renderWithProviders(
      <AssistantBridgeProvider>
        {editor && <Registrar {...editor} />}
        <Panel cards={[]} />
      </AssistantBridgeProvider>,
      { route: '/templates/t1' },
    );
    const input = await screen.findByLabelText('Сообщение ассистенту');
    await userEvent.type(input, 'привет{Enter}');
    await waitFor(() => expect(calls.some((c) => c.path === '/api/assistant/chat')).toBe(true));
    return calls.find((c) => c.path === '/api/assistant/chat')?.body as { page: object };
  };

  it('редактор зарегистрирован — templateId и черновики в page', async () => {
    const body = await send({ templateId: 't1' });
    expect(body.page).toEqual({ path: '/templates/t1', templateId: 't1', editor: saved });
  });

  it('редактора нет — page без templateId и editor', async () => {
    const body = await send(null);
    expect(body.page).toEqual({ path: '/templates/t1' });
  });
});
