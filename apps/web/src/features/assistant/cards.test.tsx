import type {
  Card,
  DocSnapshot,
  EditorDraft,
  SheetLayout,
  SheetSnapshot,
} from '@carbone-reports/shared';
import { act, fireEvent, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi, renderWithProviders, wrapper } from '../../test/utils';
import { AssistantBridgeProvider, useAssistantBridge, type TabRegistration } from './bridge';
import { AssistantPanel } from './AssistantPanel';
import type { DocumentAdapter } from './documentAdapter';
import { gridLayout, textLayout, type SheetAdapter } from './sheetAdapter';
import { overlaps } from './sheetOverlap';
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
    templateName: templateId === 't1' ? 'Счёт' : 'Акт',
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

interface DocOptions {
  adapter: DocumentAdapter;
  editable?: boolean;
}

interface SheetOptions {
  adapter: SheetAdapter;
  editable?: boolean;
}

function Registrar({
  templateId,
  dirtyTab,
  doc,
  fileExt,
  sheet,
}: {
  templateId: string;
  dirtyTab?: boolean;
  doc?: DocOptions;
  fileExt?: string;
  sheet?: SheetOptions;
}) {
  const { registerEditor, registerTab, registerDocument, registerSheet } = useAssistantBridge();
  useEffect(() => {
    const off = registerEditor({
      templateId,
      templateName: 'Счёт',
      fileExt,
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
    const offDoc = doc
      ? registerDocument({
          templateId,
          adapter: doc.adapter,
          editable: () => doc.editable ?? true,
        })
      : () => {};
    const offSheet = sheet
      ? registerSheet({
          templateId,
          adapter: sheet.adapter,
          editable: () => sheet.editable ?? true,
        })
      : () => {};
    return () => {
      offSheet();
      offDoc();
      offTab();
      off();
    };
  }, [
    registerEditor,
    registerTab,
    registerDocument,
    registerSheet,
    templateId,
    dirtyTab,
    doc,
    fileExt,
    sheet,
  ]);
  return null;
}

function Panel({ cards }: { cards: Card[] }) {
  const chat = useAssistantChat();
  // Карточки кладутся в ленту напрямую через ответ чата в тестах ниже.
  return <AssistantPanel chat={chat} key={cards.length} />;
}

function setup(
  cards: Card[],
  editor: {
    templateId: string;
    dirtyTab?: boolean;
    doc?: DocOptions;
    fileExt?: string;
    sheet?: SheetOptions;
  } | null = {
    templateId: 't1',
  },
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

afterEach(() => {
  vi.restoreAllMocks();
  // Заглушки ClipboardItem снимаются и при упавшей проверке.
  vi.unstubAllGlobals();
});

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
    expect(screen.getByText('Откройте шаблон «Акт», чтобы применить')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Копировать' }));
    expect(writeText).toHaveBeenCalledWith('select 1');
    expect(await screen.findByText('Скопировано')).toBeInTheDocument();
  });

  it('буфер недоступен или writeText отклонён — ошибка, а не «Скопировано»', async () => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    const view = setup([
      { type: 'tags', templateId: 't1', templateName: 'Счёт', text: 'x', explanation: '' },
    ]);
    await userEvent.click(await screen.findByRole('button', { name: 'Копировать' }));
    const msg = 'Не удалось скопировать — выделите текст и скопируйте вручную';
    expect(await screen.findByText(msg)).toBeInTheDocument();
    expect(screen.queryByText('Скопировано')).toBeNull();
    view.unmount();
    const writeText = vi.fn().mockRejectedValue(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    setup([{ type: 'tags', templateId: 't1', templateName: 'Счёт', text: 'x', explanation: '' }]);
    await userEvent.click(await screen.findByRole('button', { name: 'Копировать' }));
    expect(await screen.findByText(msg)).toBeInTheDocument();
    expect(screen.queryByText('Скопировано')).toBeNull();
  });

  it('параметр: «Создать параметр» / «Обновить «from»»', async () => {
    setup([
      {
        type: 'param',
        templateId: 't1',
        templateName: 'Счёт',
        param: { ...param, name: 'to', label: 'По' },
      },
      { type: 'param', templateId: 't1', templateName: 'Счёт', param },
    ]);
    expect(await screen.findByRole('button', { name: 'Создать параметр' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Обновить «from»' })).toBeEnabled();
    expect(screen.getAllByText(/Дата/).length).toBeGreaterThan(0);
  });

  it('фрагмент: моноширинный текст, «Копировать», подсказка Ctrl+V', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    setup([
      {
        type: 'tags',
        templateId: 't1',
        templateName: 'Счёт',
        text: '{d.items[i].name}',
        explanation: 'Строка таблицы',
      },
    ]);
    const code = await screen.findByText('{d.items[i].name}');
    expect(code.tagName).toBe('PRE');
    expect(code).toHaveClass('cr-assistant__code');
    expect(screen.getByText('Вставьте в документ: Ctrl+V')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Копировать' }));
    expect(writeText).toHaveBeenCalledWith('{d.items[i].name}');
  });

  describe('таблица', () => {
    const tableCard = (header = 'Товар'): Card => ({
      type: 'table',
      templateId: 't1',
      templateName: 'Счёт',
      key: 'items',
      rows: [
        [header, 'Кол-во'],
        ['{d.items[i].name}', '{d.items[i].qty:formatN(2)}'],
        ['{d.items[i+1].name}', ''],
      ],
      explanation: 'Строки счёта',
    });
    const blobText = (b: Blob) =>
      new Promise<string>((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as string);
        r.readAsText(b);
      });
    const pipe = [
      '| <b> | Кол-во |',
      '| {d.items[i].name} | {d.items[i].qty:formatN(2)} |',
      '| {d.items[i+1].name} |  |',
    ].join('\n');

    it('превью: таблица со служебной строкой [i+1] и подписью, пояснение и подсказка', async () => {
      setup([tableCard()]);
      const table = await screen.findByRole('table');
      expect(within(table).getByText('Товар')).toBeInTheDocument();
      expect(within(table).getByText('{d.items[i].qty:formatN(2)}')).toBeInTheDocument();
      const service = within(table).getByText('{d.items[i+1].name}').closest('tr');
      expect(service).toHaveClass('cr-assistant__table-service');
      expect(screen.getByText('Служебная строка — в отчёт не попадает')).toBeInTheDocument();
      expect(screen.getByText('Строки счёта')).toBeInTheDocument();
      expect(
        screen.getByText('Вставьте в документ: Ctrl+V или перетащите таблицу'),
      ).toBeInTheDocument();
    });

    it('«Копировать таблицу»: HTML-таблица с экранированием и текст с разделителями', async () => {
      const write = vi.fn().mockResolvedValue(undefined);
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', {
        value: { write, writeText },
        configurable: true,
      });
      class FakeItem {
        constructor(public items: Record<string, Blob>) {}
      }
      vi.stubGlobal('ClipboardItem', FakeItem);
      setup([tableCard('<b>')]);
      await userEvent.click(await screen.findByRole('button', { name: 'Копировать таблицу' }));
      expect(await screen.findByText('Скопировано')).toBeInTheDocument();
      expect(writeText).not.toHaveBeenCalled();
      const item = write.mock.calls[0]![0][0] as FakeItem;
      const html = await blobText(item.items['text/html']!);
      expect(html).toContain('<table');
      expect(html).toContain('[i+1]');
      expect(html).toContain('&lt;b&gt;');
      expect(html).not.toContain('<b>');
      expect(await blobText(item.items['text/plain']!)).toBe(pipe);
    });

    it('без clipboard.write или ClipboardItem — текстом и предупреждение про https', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      vi.stubGlobal('ClipboardItem', undefined);
      setup([tableCard('<b>')]);
      await userEvent.click(await screen.findByRole('button', { name: 'Копировать таблицу' }));
      expect(writeText).toHaveBeenCalledWith(pipe);
      expect(
        await screen.findByText('Скопировано текстом: таблицей копируется только по https'),
      ).toBeInTheDocument();
    });

    it('clipboard.write отклонён — ошибка копирования', async () => {
      const write = vi.fn().mockRejectedValue(new Error('denied'));
      Object.defineProperty(navigator, 'clipboard', {
        value: { write, writeText: vi.fn() },
        configurable: true,
      });
      vi.stubGlobal('ClipboardItem', class {});
      setup([tableCard()]);
      await userEvent.click(await screen.findByRole('button', { name: 'Копировать таблицу' }));
      expect(
        await screen.findByText('Не удалось скопировать — выделите текст и скопируйте вручную'),
      ).toBeInTheDocument();
    });

    it('перетаскивание за ручку: HTML и текст, копирование; таблица выделяется', async () => {
      setup([tableCard('<b>')]);
      const table = await screen.findByRole('table');
      // Сама таблица не перетаскивается: текст можно выделить и скопировать вручную.
      expect(table).not.toHaveAttribute('draggable');
      const handle = screen.getByLabelText('Перетащить таблицу в документ');
      expect(handle).toHaveAttribute('draggable', 'true');
      const setData = vi.fn();
      const dataTransfer = { setData, effectAllowed: 'none' };
      fireEvent.dragStart(handle, { dataTransfer });
      expect(setData).toHaveBeenCalledWith('text/plain', pipe);
      const html = setData.mock.calls.find(([f]) => f === 'text/html')?.[1] as string;
      expect(html).toContain('<table');
      expect(html).toContain('&lt;b&gt;');
      expect(dataTransfer.effectAllowed).toBe('copy');
    });

    it('в историю — ключ и заголовки столбцов', () => {
      const { result } = renderHook(() => useCardText(), { wrapper });
      expect(result.current(tableCard())).toBe('Предложена таблица для «items»: Товар, Кол-во');
    });
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
    expect(result.current({ type: 'param', templateId: 't1', templateName: 'Счёт', param })).toBe(
      'Предложен параметр «from» (date)',
    );
    expect(
      result.current({
        type: 'tags',
        templateId: 't1',
        templateName: 'Счёт',
        text: '{d.x}',
        explanation: '',
      }),
    ).toBe('Предложен фрагмент документа: {d.x}');
  });
});

describe('формирование в документе (§52.4)', () => {
  const fakeAdapter = (snapshot: DocSnapshot = { blocks: [], truncated: false }) => ({
    snapshot: vi.fn(async () => snapshot),
    insertTags: vi.fn(async () => {}),
    insertTable: vi.fn(async () => {}),
    replaceAll: vi.fn(async () => {}),
    replace: vi.fn(async () => ({ notFound: { items: [] as number[], tables: [] as number[] } })),
    dispose: vi.fn(),
  });
  const tags: Card = {
    type: 'tags',
    templateId: 't1',
    templateName: 'Счёт',
    text: '{d.number}',
    explanation: '',
  };
  const rows = [['Товар'], ['{d.items[i].name}'], ['{d.items[i+1].name}']];
  const table: Card = {
    type: 'table',
    templateId: 't1',
    templateName: 'Счёт',
    key: 'items',
    rows,
    explanation: '',
  };
  const documentCard: Extract<Card, { type: 'document' }> = {
    type: 'document',
    templateId: 't1',
    templateName: 'Счёт',
    blocks: [
      { type: 'heading', level: 1, text: 'Счёт № {d.number}' },
      { type: 'p', text: 'Покупатель: {d.buyer}' },
      { type: 'table', key: 'items', rows },
      { type: 'heading', level: 2, text: 'Итого' },
    ],
    explanation: 'Счёт на оплату',
  };
  const replaceCard: Extract<Card, { type: 'replace' }> = {
    type: 'replace',
    templateId: 't1',
    templateName: 'Счёт',
    items: [
      { find: 'ООО Ромашка', tag: '{d.buyer}', count: 1 },
      { find: '15.03.2026', tag: '{d.date}', note: 'дата счёта', count: 3 },
    ],
    tables: [
      {
        block: 4,
        headerRows: 1,
        key: 'items',
        fingerprint: { header: [['Товар', 'Кол-во']], columns: 2, sample: ['Стол', '2'] },
        rowTags: ['{d.items[i].name}', '{d.items[i].qty}'],
        serviceRow: ['{d.items[i+1].name}', ''],
      },
    ],
    explanation: '',
  };
  const insert = 'Вставить в документ';

  it('без возможности у фрагмента и таблицы нет «Вставить в документ»', async () => {
    setup([tags, table]);
    expect(await screen.findByRole('button', { name: 'Копировать таблицу' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: insert })).toBeNull();
  });

  it('документ открыт — фрагмент и таблица вставляются через адаптер, уведомление', async () => {
    const adapter = fakeAdapter();
    setup([tags, table], { templateId: 't1', doc: { adapter } });
    const [tagsBtn, tableBtn] = await screen.findAllByRole('button', { name: insert });
    await userEvent.click(tagsBtn!);
    expect(adapter.insertTags).toHaveBeenCalledWith('{d.number}');
    expect(await screen.findByText('Изменено в документе')).toBeInTheDocument();
    await userEvent.click(tableBtn!);
    expect(adapter.insertTable).toHaveBeenCalledWith(rows);
  });

  it('лист xlsx открыт — кнопок формирования в документе нет (лист — свой путь, §53.4)', async () => {
    const sheet: SheetAdapter = {
      snapshot: vi.fn(async () => ({
        name: 'S',
        cells: [],
        usedRange: 'A1',
        active: 'A1',
        truncated: false,
      })),
      insertCells: vi.fn(async () => {}),
      applyLayout: vi.fn(async () => {}),
      replace: vi.fn(async () => ({ notFound: { items: [], table: false } })),
      dispose: vi.fn(),
    };
    setup([tags, table, documentCard, replaceCard], {
      templateId: 't1',
      fileExt: 'xlsx',
      sheet: { adapter: sheet },
    });
    expect(await screen.findByText('Счёт № {d.number}')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: insert })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Сформировать документ' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Заменить выбранное/ })).toBeNull();
  });

  it('документ другого шаблона — кнопки нет', async () => {
    setup([{ ...tags, templateId: 't2' }], { templateId: 't1', doc: { adapter: fakeAdapter() } });
    expect(await screen.findByRole('button', { name: 'Копировать' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: insert })).toBeNull();
  });

  it('документ только для просмотра — кнопка неактивна с подсказкой', async () => {
    setup([tags], { templateId: 't1', doc: { adapter: fakeAdapter(), editable: false } });
    expect(await screen.findByRole('button', { name: insert })).toBeDisabled();
    expect(screen.getByText('Чтобы изменить документ, начните редактирование')).toBeInTheDocument();
  });

  it('вкладка «Документ» не смонтирована — кнопка есть, блокировка проверяется при применении', async () => {
    let bridge: ReturnType<typeof useAssistantBridge> | null = null;
    function Capture() {
      bridge = useAssistantBridge();
      return null;
    }
    const first = fakeAdapter();
    const off = { current: () => {} };
    sessionStorage.clear();
    sessionStorage.setItem(
      ASSISTANT_KEY,
      JSON.stringify({
        open: true,
        messages: [{ role: 'assistant', content: 'Вот', cards: [tags] }],
      }),
    );
    renderWithProviders(
      <AssistantBridgeProvider>
        <Registrar templateId="t1" />
        <Capture />
        <Panel cards={[tags]} />
      </AssistantBridgeProvider>,
    );
    await waitFor(() => expect(bridge?.editor).not.toBeNull());
    // Connector был, вкладку закрыли: признак возможности остаётся.
    act(() => {
      off.current = bridge!.registerDocument({
        templateId: 't1',
        adapter: first,
        editable: () => true,
      });
    });
    act(() => off.current());
    await userEvent.click(await screen.findByRole('button', { name: insert }));
    // Документ открылся только для просмотра — вместо изменения подсказка.
    const second = fakeAdapter();
    act(() => {
      bridge!.registerDocument({ templateId: 't1', adapter: second, editable: () => false });
    });
    expect(
      await screen.findAllByText('Чтобы изменить документ, начните редактирование'),
    ).not.toHaveLength(0);
    expect(second.insertTags).not.toHaveBeenCalled();
  });

  describe('отложенное действие (вкладка «Документ» не смонтирована)', () => {
    let bridge: ReturnType<typeof useAssistantBridge> | null = null;
    function Capture() {
      bridge = useAssistantBridge();
      return null;
    }
    /** Панель с карточкой tags; connector уже создавался, вкладка «Документ» закрыта. */
    async function renderDeferred() {
      bridge = null;
      sessionStorage.clear();
      sessionStorage.setItem(
        ASSISTANT_KEY,
        JSON.stringify({
          open: true,
          messages: [{ role: 'assistant', content: 'Вот', cards: [tags] }],
        }),
      );
      renderWithProviders(
        <AssistantBridgeProvider>
          <Registrar templateId="t1" />
          <Capture />
          <Panel cards={[tags]} />
        </AssistantBridgeProvider>,
      );
      await waitFor(() => expect(bridge?.editor).not.toBeNull());
      act(() => {
        bridge!.registerDocument({
          templateId: 't1',
          adapter: fakeAdapter(),
          editable: () => true,
        })();
      });
      const btn = await screen.findByRole('button', { name: insert });
      await userEvent.click(btn);
      // Действие отложено (вкладка открывается): кнопка занята до его выполнения.
      await waitFor(() => expect(btn).toBeDisabled());
      return btn;
    }
    const mountDocument = async (adapter: DocumentAdapter) =>
      act(async () => {
        bridge!.registerDocument({ templateId: 't1', adapter, editable: () => true });
      });

    it('повторный клик, пока действие ждёт документ, не ставит его второй раз', async () => {
      const btn = await renderDeferred();
      await userEvent.click(btn);
      fireEvent.click(btn);
      const adapter = fakeAdapter();
      await mountDocument(adapter);
      await waitFor(() => expect(adapter.insertTags).toHaveBeenCalledTimes(1));
      expect(await screen.findByText('Изменено в документе')).toBeInTheDocument();
      await waitFor(() => expect(btn).toBeEnabled());
    });

    it('clearPending снимает действие — кнопка снова доступна, действие не выполняется', async () => {
      await renderDeferred();
      act(() => bridge!.clearPending());
      // clearPending снимает и признак: восстанавливаем его, как при следующем открытии документа.
      const adapter = fakeAdapter();
      await mountDocument(adapter);
      expect(await screen.findByRole('button', { name: insert })).toBeEnabled();
      expect(adapter.insertTags).not.toHaveBeenCalled();
    });

    it('revokeDocument (возможность пропала) — кнопок нет, действие снято', async () => {
      await renderDeferred();
      act(() => bridge!.revokeDocument('t1'));
      await waitFor(() => expect(screen.queryByRole('button', { name: insert })).toBeNull());
      const adapter = fakeAdapter();
      await mountDocument(adapter);
      expect(adapter.insertTags).not.toHaveBeenCalled();
      // Документ снова с возможностью — кнопка доступна (не занята снятым действием).
      expect(await screen.findByRole('button', { name: insert })).toBeEnabled();
    });
  });

  it('ошибка адаптера — общее уведомление об ошибке', async () => {
    const adapter = fakeAdapter();
    adapter.insertTags.mockRejectedValue(new Error('timeout'));
    setup([tags], { templateId: 't1', doc: { adapter } });
    await userEvent.click(await screen.findByRole('button', { name: insert }));
    expect(await screen.findByText('Не удалось изменить документ')).toBeInTheDocument();
    expect(screen.queryByText('Изменено в документе')).toBeNull();
  });

  describe('документ', () => {
    const filled: DocSnapshot = {
      blocks: [
        { type: 'p', text: 'Колонтитул', area: 'header' },
        { type: 'p', text: 'Старый текст', area: 'body' },
      ],
      truncated: false,
    };

    it('превью: заголовки, абзацы, таблица со служебной строкой', async () => {
      setup([documentCard], { templateId: 't1', doc: { adapter: fakeAdapter() } });
      expect(await screen.findByText('Счёт № {d.number}')).toBeInTheDocument();
      expect(screen.getByText('Покупатель: {d.buyer}')).toBeInTheDocument();
      const service = within(screen.getByRole('table')).getByText('{d.items[i+1].name}');
      expect(service.closest('tr')).toHaveClass('cr-assistant__table-service');
      expect(screen.getByText('Счёт на оплату')).toBeInTheDocument();
    });

    it('без возможности — без кнопки «Сформировать документ»', async () => {
      setup([documentCard]);
      expect(await screen.findByText('Счёт № {d.number}')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Сформировать документ' })).toBeNull();
    });

    it('пустое тело (колонтитулы не в счёт) — замена без вопроса', async () => {
      const adapter = fakeAdapter({
        blocks: [
          { type: 'p', text: 'Колонтитул', area: 'header' },
          { type: 'p', text: '  ', area: 'body' },
        ],
        truncated: false,
      });
      setup([documentCard], { templateId: 't1', doc: { adapter } });
      await userEvent.click(await screen.findByRole('button', { name: 'Сформировать документ' }));
      await waitFor(() => expect(adapter.replaceAll).toHaveBeenCalledWith(documentCard.blocks));
      expect(await screen.findByText('Изменено в документе')).toBeInTheDocument();
    });

    it('непустой документ — подтверждение; отмена — replaceAll не вызван', async () => {
      const adapter = fakeAdapter(filled);
      setup([documentCard], { templateId: 't1', doc: { adapter } });
      await userEvent.click(await screen.findByRole('button', { name: 'Сформировать документ' }));
      const dialog = await screen.findByRole('dialog');
      expect(
        within(dialog).getByText('Заменить содержимое документа? Отменить можно через Ctrl+Z'),
      ).toBeInTheDocument();
      await userEvent.click(within(dialog).getByRole('button', { name: 'Отмена' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(adapter.replaceAll).not.toHaveBeenCalled();
      expect(screen.queryByText('Изменено в документе')).toBeNull();
    });

    it('непустой документ — подтверждение; «Заменить» — replaceAll', async () => {
      const adapter = fakeAdapter(filled);
      setup([documentCard], { templateId: 't1', doc: { adapter } });
      await userEvent.click(await screen.findByRole('button', { name: 'Сформировать документ' }));
      const dialog = await screen.findByRole('dialog');
      await userEvent.click(within(dialog).getByRole('button', { name: 'Заменить' }));
      await waitFor(() => expect(adapter.replaceAll).toHaveBeenCalledWith(documentCard.blocks));
      expect(await screen.findByText('Изменено в документе')).toBeInTheDocument();
    });
  });

  describe('замены', () => {
    it('список «было → станет», ×N, таблица отдельным пунктом; все отмечены', async () => {
      setup([replaceCard], { templateId: 't1', doc: { adapter: fakeAdapter() } });
      const boxes = await screen.findAllByRole('checkbox');
      expect(boxes).toHaveLength(3);
      for (const b of boxes) expect(b).toBeChecked();
      expect(screen.getByText('ООО Ромашка → {d.buyer}')).toBeInTheDocument();
      expect(screen.getByText('×3')).toBeInTheDocument();
      expect(screen.queryByText('×1')).toBeNull();
      expect(screen.getByText('дата счёта')).toBeInTheDocument();
      expect(screen.getByText('Таблица: Товар, Кол-во → строки «items»')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Заменить выбранное (3)' })).toBeEnabled();
    });

    it('снятая галочка уменьшает счётчик и исключает пункт; 0 — кнопка неактивна', async () => {
      const adapter = fakeAdapter();
      setup([replaceCard], { templateId: 't1', doc: { adapter } });
      const boxes = await screen.findAllByRole('checkbox');
      await userEvent.click(boxes[0]!);
      await userEvent.click(screen.getByRole('button', { name: 'Заменить выбранное (2)' }));
      await waitFor(() =>
        expect(adapter.replace).toHaveBeenCalledWith([replaceCard.items[1]], replaceCard.tables),
      );
      expect(await screen.findByText('Изменено в документе')).toBeInTheDocument();
      await userEvent.click(boxes[1]!);
      await userEvent.click(boxes[2]!);
      expect(screen.getByRole('button', { name: 'Заменить выбранное (0)' })).toBeDisabled();
    });

    it('notFound помечает пункты «не найдено» (индексы — среди выбранных)', async () => {
      const adapter = fakeAdapter();
      adapter.replace.mockResolvedValue({ notFound: { items: [0], tables: [0] } });
      setup([replaceCard], { templateId: 't1', doc: { adapter } });
      const boxes = await screen.findAllByRole('checkbox');
      await userEvent.click(boxes[0]!);
      await userEvent.click(screen.getByRole('button', { name: 'Заменить выбранное (2)' }));
      await waitFor(() => expect(screen.getAllByText('не найдено')).toHaveLength(2));
      // Не найден второй пункт (первый среди выбранных) и таблица; первый пункт не помечен.
      expect(boxes[0]!.closest('li')).not.toHaveTextContent('не найдено');
      expect(boxes[1]!.closest('li')).toHaveTextContent('не найдено');
      expect(boxes[2]!.closest('li')).toHaveTextContent('не найдено');
    });
  });

  it('в историю — заголовки документа и число замен', () => {
    const { result } = renderHook(() => useCardText(), { wrapper });
    expect(result.current(documentCard)).toBe('Предложен документ: Счёт № {d.number}; Итого');
    const long = 'а'.repeat(150);
    expect(result.current({ ...documentCard, blocks: [{ type: 'p', text: long }] })).toBe(
      `Предложен документ: ${'а'.repeat(100)}`,
    );
    expect(result.current(replaceCard)).toBe('Предложены замены: 2 значений, 1 таблиц');
    const many = Array.from({ length: 60 }, (_, i) => ({
      type: 'heading' as const,
      level: 1 as const,
      text: `${i}`.repeat(100),
    }));
    expect(result.current({ ...documentCard, blocks: many }).length).toBeLessThanOrEqual(4000);
  });
});

describe('формирование в листе (§53.3)', () => {
  const emptySnapshot: SheetSnapshot = {
    name: 'Лист1',
    cells: [],
    usedRange: 'A1',
    active: 'B2',
    truncated: false,
  };
  const fakeSheet = (snapshot: SheetSnapshot = emptySnapshot) => ({
    snapshot: vi.fn(async () => snapshot),
    insertCells: vi.fn(async () => {}),
    applyLayout: vi.fn(async () => {}),
    replace: vi.fn(async () => ({ notFound: { items: [] as number[], table: false } })),
    dispose: vi.fn(),
  });
  const inSheet = (adapter: SheetAdapter, editable = true) => ({
    templateId: 't1',
    fileExt: 'xlsx',
    sheet: { adapter, editable },
  });
  const tags: Card = {
    type: 'tags',
    templateId: 't1',
    templateName: 'Счёт',
    text: '{d.number}\n{d.date}',
    explanation: '',
  };
  const rows = [
    ['Товар', 'Цена'],
    ['{d.items[i].name}', '{d.items[i].price}'],
    ['{d.items[i+1].name}', ''],
  ];
  const tableLayout: SheetLayout = {
    rows: 2,
    cols: 2,
    widths: [20, 10],
    cells: [
      { row: 0, col: 0, value: 'Товар', kind: 'text', style: 'header' },
      { row: 0, col: 1, value: 'Цена', kind: 'text', style: 'header' },
      { row: 1, col: 0, value: '{d.items[i].name}', kind: 'text', style: 'data' },
      { row: 1, col: 1, value: '{d.items[i].price}', kind: 'decimal', style: 'data' },
    ],
  };
  const table: Card = {
    type: 'table',
    templateId: 't1',
    templateName: 'Счёт',
    key: 'items',
    rows,
    explanation: '',
  };
  const bigLayout: SheetLayout = {
    rows: 14,
    cols: 2,
    widths: [20, 10],
    cells: Array.from({ length: 14 }, (_, row) => ({
      row,
      col: 0,
      value: `Строка ${row + 1}`,
      kind: 'text' as const,
      style: 'plain' as const,
    })),
  };
  const sheetCard: Extract<Card, { type: 'sheet' }> = {
    type: 'sheet',
    templateId: 't1',
    templateName: 'Счёт',
    key: 'items',
    layout: bigLayout,
    explanation: 'Лист счёта',
  };
  const sheetReplaceCard: Extract<Card, { type: 'sheetReplace' }> = {
    type: 'sheetReplace',
    templateId: 't1',
    templateName: 'Счёт',
    items: [
      { ref: 'B2', find: 'ООО Ромашка', tag: '{d.buyer}' },
      { ref: 'C3', find: '15.03.2026', tag: '{d.date}', note: 'дата счёта' },
    ],
    table: {
      key: 'items',
      grouped: false,
      firstCol: 0,
      headerRow: 4,
      firstDataRow: 5,
      lastDataRow: 9,
      rowShift: -3,
      fingerprint: { header: ['Товар', 'Цена'], columns: 2, sample: ['Стол', '100'] },
      rows: [
        { styleFrom: 5, cells: ['{d.items[i].name}', '{d.items[i].price}'] },
        { styleFrom: 5, cells: ['{d.items[i+1].name}', ''] },
      ],
      totals: null,
    },
    explanation: '',
  };
  const insertSheet = 'Вставить в таблицу';
  const formSheet = 'Сформировать лист';

  it('overlaps: ячейка раскладки на непустой ячейке снимка; truncated — всегда', () => {
    const snap: SheetSnapshot = { ...emptySnapshot, cells: [{ ref: 'C3', text: 'x' }] };
    expect(overlaps(snap, 'B2', tableLayout)).toBe(true);
    expect(overlaps(snap, 'D3', tableLayout)).toBe(false);
    expect(overlaps(snap, 'A1', tableLayout)).toBe(false);
    expect(overlaps({ ...emptySnapshot, truncated: true }, 'Z99', tableLayout)).toBe(true);
    // Пустые значения раскладки адаптер не пишет — ячейка под ними не перезаписывается.
    expect(
      overlaps(
        snap,
        'B2',
        gridLayout([
          ['a', 'b'],
          ['c', ''],
        ]),
      ),
    ).toBe(false);
    expect(
      overlaps(
        snap,
        'B2',
        gridLayout([
          ['a', 'b'],
          ['c', 'd'],
        ]),
      ),
    ).toBe(true);
  });

  it('без возможности у фрагмента и таблицы в xlsx нет кнопок формирования', async () => {
    setup([tags, table], { templateId: 't1', fileExt: 'xlsx' });
    expect(await screen.findByRole('button', { name: 'Копировать таблицу' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: insertSheet })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Вставить в документ' })).toBeNull();
  });

  it('«Вставить в таблицу»: фрагмент — строками вниз от активной ячейки, таблица — раскладкой', async () => {
    const adapter = fakeSheet();
    setup([tags, { ...table, layout: tableLayout }, { ...table, key: 'other' }], inSheet(adapter));
    // Таблица без раскладки сервера (запрос без снимка листа) — только копирование (final #2).
    const buttons = await screen.findAllByRole('button', { name: insertSheet });
    expect(buttons).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Копировать таблицу' })).toHaveLength(2);
    const [tagsBtn, layoutBtn] = buttons;
    expect(screen.queryByRole('button', { name: 'Вставить в документ' })).toBeNull();
    await userEvent.click(tagsBtn!);
    await waitFor(() =>
      expect(adapter.insertCells).toHaveBeenCalledWith('B2', textLayout('{d.number}\n{d.date}')),
    );
    expect(await screen.findByText('Изменено в документе')).toBeInTheDocument();
    await userEvent.click(layoutBtn!);
    await waitFor(() => expect(adapter.insertCells).toHaveBeenLastCalledWith('B2', tableLayout));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('непустые ячейки под раскладкой — подтверждение; отказ — insertCells не вызван', async () => {
    const adapter = fakeSheet({ ...emptySnapshot, cells: [{ ref: 'B3', text: 'старое' }] });
    setup([tags], inSheet(adapter));
    await userEvent.click(await screen.findByRole('button', { name: insertSheet }));
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText('Перезаписать непустые ячейки? Отменить можно через Ctrl+Z'),
    ).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Отмена' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(adapter.insertCells).not.toHaveBeenCalled();
    expect(screen.queryByText('Изменено в документе')).toBeNull();
  });

  it('снимок усечён — подтверждение всегда; согласие — insertCells', async () => {
    const adapter = fakeSheet({ ...emptySnapshot, truncated: true });
    setup([tags], inSheet(adapter));
    await userEvent.click(await screen.findByRole('button', { name: insertSheet }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Перезаписать' }));
    await waitFor(() => expect(adapter.insertCells).toHaveBeenCalledTimes(1));
  });

  it('лист: превью из первых 10 строк раскладки, пояснение; пустой лист — без вопроса', async () => {
    const adapter = fakeSheet();
    setup([sheetCard], inSheet(adapter));
    expect(await screen.findByText('Строка 10')).toBeInTheDocument();
    expect(screen.queryByText('Строка 11')).toBeNull();
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(10);
    expect(screen.getByText('Лист счёта')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: formSheet }));
    await waitFor(() => expect(adapter.applyLayout).toHaveBeenCalledWith(bigLayout));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await screen.findByText('Изменено в документе')).toBeInTheDocument();
  });

  it('лист: без возможности — без кнопки «Сформировать лист»', async () => {
    setup([sheetCard], { templateId: 't1', fileExt: 'xlsx' });
    expect(await screen.findByText('Строка 1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: formSheet })).toBeNull();
  });

  it('лист: непустой — подтверждение; отмена и согласие', async () => {
    const adapter = fakeSheet({ ...emptySnapshot, cells: [{ ref: 'Z50', text: 'x' }] });
    setup([sheetCard], inSheet(adapter));
    await userEvent.click(await screen.findByRole('button', { name: formSheet }));
    let dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText('Заменить содержимое листа? Отменить можно через Ctrl+Z'),
    ).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Отмена' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(adapter.applyLayout).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: formSheet }));
    dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Заменить' }));
    await waitFor(() => expect(adapter.applyLayout).toHaveBeenCalledWith(bigLayout));
  });

  it('лист только для просмотра — кнопки неактивны с подсказкой', async () => {
    setup([tags, sheetCard, sheetReplaceCard], inSheet(fakeSheet(), false));
    expect(await screen.findByRole('button', { name: insertSheet })).toBeDisabled();
    expect(screen.getByRole('button', { name: formSheet })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Заменить выбранное (3)' })).toBeDisabled();
    expect(screen.getAllByText('Чтобы изменить документ, начните редактирование')).toHaveLength(3);
  });

  describe('замены в листе', () => {
    it('«было → станет» с адресом, таблица строками 1-based; все отмечены', async () => {
      setup([sheetReplaceCard], inSheet(fakeSheet()));
      const boxes = await screen.findAllByRole('checkbox');
      expect(boxes).toHaveLength(3);
      for (const b of boxes) expect(b).toBeChecked();
      expect(screen.getByText('ООО Ромашка → {d.buyer}')).toBeInTheDocument();
      expect(boxes[0]!.closest('li')).toHaveTextContent('B2');
      expect(screen.getByText('дата счёта')).toBeInTheDocument();
      expect(screen.getByText('Таблица: строки 6–10 → «items»')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Заменить выбранное (3)' })).toBeEnabled();
    });

    it('снятая галочка уменьшает счётчик и исключает пункт; снятая таблица — null', async () => {
      const adapter = fakeSheet();
      setup([sheetReplaceCard], inSheet(adapter));
      const boxes = await screen.findAllByRole('checkbox');
      await userEvent.click(boxes[0]!);
      await userEvent.click(boxes[2]!);
      await userEvent.click(screen.getByRole('button', { name: 'Заменить выбранное (1)' }));
      await waitFor(() =>
        expect(adapter.replace).toHaveBeenCalledWith([sheetReplaceCard.items[1]], null),
      );
      expect(await screen.findByText('Изменено в документе')).toBeInTheDocument();
      await userEvent.click(boxes[1]!);
      expect(screen.getByRole('button', { name: 'Заменить выбранное (0)' })).toBeDisabled();
    });

    it('notFound помечает пункты и таблицу «не найдено» (индексы — среди выбранных)', async () => {
      const adapter = fakeSheet();
      adapter.replace.mockResolvedValue({ notFound: { items: [0], table: true } });
      setup([sheetReplaceCard], inSheet(adapter));
      const boxes = await screen.findAllByRole('checkbox');
      await userEvent.click(boxes[0]!);
      await userEvent.click(screen.getByRole('button', { name: 'Заменить выбранное (2)' }));
      await waitFor(() =>
        expect(adapter.replace).toHaveBeenCalledWith(
          [sheetReplaceCard.items[1]],
          sheetReplaceCard.table,
        ),
      );
      await waitFor(() => expect(screen.getAllByText('не найдено')).toHaveLength(2));
      expect(boxes[0]!.closest('li')).not.toHaveTextContent('не найдено');
      expect(boxes[1]!.closest('li')).toHaveTextContent('не найдено');
      expect(boxes[2]!.closest('li')).toHaveTextContent('не найдено');
    });
  });

  it('в историю — ключ листа и число замен (с таблицей и без)', () => {
    const { result } = renderHook(() => useCardText(), { wrapper });
    expect(result.current(sheetCard)).toBe('Предложен лист: items');
    expect(result.current(sheetReplaceCard)).toBe('Предложены замены: 2 значений, таблица');
    expect(result.current({ ...sheetReplaceCard, table: null })).toBe(
      'Предложены замены: 2 значений',
    );
    expect(result.current({ ...sheetCard, key: 'k'.repeat(5000) }).length).toBeLessThanOrEqual(
      4000,
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
