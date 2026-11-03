import type { DocSnapshot, TemplateParam } from '@carbone-reports/shared';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { DocumentAdapter } from './documentAdapter';
import {
  applyParam,
  applyQuery,
  AssistantBridgeProvider,
  limitDraft,
  useAssistantBridge,
} from './bridge';

describe('applyQuery / applyParam', () => {
  const make = (q: { key: string; mode: 'list' | 'single'; sql: string }) => ({ id: 9, ...q });
  const card = (key: string) => ({
    type: 'query' as const,
    templateId: 't',
    templateName: 'T',
    key,
    mode: 'list' as const,
    sql: 'select 2',
    check: { ok: true as const, columns: [] },
  });
  it('ключ есть — замена SQL и режима на месте', () => {
    const d = [{ id: 1, key: 'items', mode: 'single' as const, sql: 'select 1' }];
    expect(applyQuery(d, card('items'), make)).toEqual([
      { id: 1, key: 'items', mode: 'list', sql: 'select 2' },
    ]);
  });
  it('ключа нет (автор переименовал) — добавление в конец', () => {
    const d = [{ id: 1, key: 'rows', mode: 'list' as const, sql: 'select 1' }];
    expect(applyQuery(d, card('items'), make)).toEqual([
      ...d,
      { id: 9, key: 'items', mode: 'list', sql: 'select 2' },
    ]);
  });
  it('параметр: по имени — замена, иначе добавление', () => {
    const p = (name: string, label: string): TemplateParam => ({
      name,
      label,
      type: 'string' as const,
      required: false,
      defaultValue: null,
      options: null,
      sql: null,
      multiple: false,
    });
    const pc = (param: ReturnType<typeof p>) => ({
      type: 'param' as const,
      templateId: 't',
      templateName: 'T',
      param,
    });
    const makeP = (x: ReturnType<typeof p>) => ({ id: 9, ...x });
    const d = [{ id: 1, ...p('from', 'С') }];
    expect(applyParam(d, pc(p('from', 'С даты')), makeP)).toEqual([
      { id: 1, ...p('from', 'С даты') },
    ]);
    expect(applyParam(d, pc(p('to', 'По')), makeP)).toEqual([...d, { id: 9, ...p('to', 'По') }]);
  });
});

describe('limitDraft', () => {
  it('отбрасывает лишнее и невалидное, чтобы сервер не отклонил весь запрос чата', () => {
    const q = (i: number) => ({ key: `q${i}`, mode: 'list' as const, sql: 'select 1' });
    const good = (name: string) => ({
      name,
      label: 'L',
      type: 'string' as const,
      required: false,
      defaultValue: null,
      options: null,
      sql: null,
      multiple: false,
    });
    const out = limitDraft({
      queries: [
        { key: 'big', mode: 'list', sql: 'x'.repeat(20_001) },
        { key: 'k'.repeat(101), mode: 'list', sql: 'select 1' },
        ...Array.from({ length: 40 }, (_, i) => q(i)),
      ],
      params: [
        { ...good('bad'), label: '' },
        ...Array.from({ length: 60 }, (_, i) => good(`p${i}`)),
      ],
    });
    expect(out.queries).toHaveLength(30);
    expect(out.queries[0]!.key).toBe('q0');
    expect(out.params).toHaveLength(50);
    expect(out.params[0]!.name).toBe('p0');
  });
});

describe('мост', () => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <AssistantBridgeProvider>{children}</AssistantBridgeProvider>
  );
  const saved = { queries: [{ key: 'a', mode: 'list' as const, sql: 'select 1' }], params: [] };
  const qcard = {
    type: 'query' as const,
    templateId: 't',
    templateName: 'T',
    key: 'b',
    mode: 'list' as const,
    sql: 'select 2',
    check: { ok: true as const, columns: [] },
  };

  it('вкладка не смонтирована — применение в очередь и openTab; takePending отдаёт и очищает', () => {
    const { result } = renderHook(() => useAssistantBridge(), { wrapper });
    const openTab = vi.fn();
    act(() => {
      result.current.registerEditor({
        templateId: 't',
        templateName: 'T',
        saved: () => saved,
        openTab,
      });
    });
    let res: unknown;
    act(() => {
      res = result.current.apply(qcard);
    });
    expect(res).toBe('opened');
    expect(openTab).toHaveBeenCalledWith('data');
    expect(result.current.takePending('query')).toEqual([qcard]);
    expect(result.current.takePending('query')).toEqual([]);
  });

  it('вкладка смонтирована — apply сразу; draft(): черновик вкладки, иначе saved()', () => {
    const { result } = renderHook(() => useAssistantBridge(), { wrapper });
    act(() => {
      result.current.registerEditor({
        templateId: 't',
        templateName: 'T',
        saved: () => saved,
        openTab: vi.fn(),
      });
    });
    expect(result.current.draft()).toEqual(saved);
    const apply = vi.fn();
    act(() => {
      result.current.registerTab({
        kind: 'query',
        draft: () => [{ key: 'x', mode: 'single', sql: 'select 3' }],
        apply,
        dirty: () => false,
      });
    });
    expect(result.current.apply(qcard)).toBe('applied');
    expect(apply).toHaveBeenCalledWith(qcard);
    expect(result.current.draft()!.queries).toEqual([
      { key: 'x', mode: 'single', sql: 'select 3' },
    ]);
  });

  it('другая вкладка с несохранёнными правками — в очередь без переключения', () => {
    const { result } = renderHook(() => useAssistantBridge(), { wrapper });
    const openTab = vi.fn();
    act(() => {
      result.current.registerEditor({
        templateId: 't',
        templateName: 'T',
        saved: () => saved,
        openTab,
      });
    });
    act(() => {
      result.current.registerTab({
        kind: 'param',
        draft: () => [],
        apply: vi.fn(),
        dirty: () => true,
      });
    });
    expect(result.current.apply(qcard)).toBe('queued');
    expect(openTab).not.toHaveBeenCalled();
    expect(result.current.takePending('query')).toEqual([qcard]);
  });

  it('вкладка без карточек (диаграммы, PDF, настройки) с правками — в очередь без переключения', () => {
    const { result } = renderHook(() => useAssistantBridge(), { wrapper });
    const openTab = vi.fn();
    act(() => {
      result.current.registerEditor({
        templateId: 't',
        templateName: 'T',
        saved: () => saved,
        openTab,
      });
    });
    let off = () => {};
    act(() => {
      off = result.current.registerDirty(() => true);
    });
    expect(result.current.apply(qcard)).toBe('queued');
    expect(openTab).not.toHaveBeenCalled();
    // Вкладка ушла — правок нет, переключение снова возможно.
    off();
    expect(result.current.apply(qcard)).toBe('opened');
    expect(openTab).toHaveBeenCalledWith('data');
  });

  it('clearPending — очередь пуста', () => {
    const { result } = renderHook(() => useAssistantBridge(), { wrapper });
    act(() => {
      result.current.registerEditor({
        templateId: 't',
        templateName: 'T',
        saved: () => saved,
        openTab: vi.fn(),
      });
    });
    act(() => {
      result.current.apply(qcard);
    });
    result.current.clearPending();
    expect(result.current.takePending('query')).toEqual([]);
  });

  it('другая вкладка без правок — в очередь и переключение', () => {
    const { result } = renderHook(() => useAssistantBridge(), { wrapper });
    const openTab = vi.fn();
    act(() => {
      result.current.registerEditor({
        templateId: 't',
        templateName: 'T',
        saved: () => saved,
        openTab,
      });
    });
    act(() => {
      result.current.registerTab({
        kind: 'param',
        draft: () => [],
        apply: vi.fn(),
        dirty: () => false,
      });
    });
    expect(result.current.apply(qcard)).toBe('opened');
    expect(openTab).toHaveBeenCalledWith('data');
    expect(result.current.takePending('query')).toEqual([qcard]);
  });

  it('снятие регистрации редактора — draft() null', () => {
    const { result } = renderHook(() => useAssistantBridge(), { wrapper });
    let off = () => {};
    act(() => {
      off = result.current.registerEditor({
        templateId: 't',
        templateName: 'T',
        saved: () => saved,
        openTab: vi.fn(),
      });
    });
    expect(result.current.editor?.templateId).toBe('t');
    act(() => off());
    expect(result.current.editor).toBeNull();
    expect(result.current.draft()).toBeNull();
  });

  describe('документ', () => {
    const snap: DocSnapshot = {
      blocks: [{ type: 'p', text: 'Счёт', area: 'body' }],
      truncated: false,
    };
    const adapter = (over: Partial<DocumentAdapter> = {}): DocumentAdapter => ({
      snapshot: vi.fn(async () => snap),
      insertTags: vi.fn(async () => {}),
      insertTable: vi.fn(async () => {}),
      replaceAll: vi.fn(async () => {}),
      replace: vi.fn(async () => ({ notFound: { items: [], tables: [] } })),
      dispose: vi.fn(),
      ...over,
    });
    const setup = () => {
      const r = renderHook(() => useAssistantBridge(), { wrapper });
      const openTab = vi.fn();
      let offEditor = () => {};
      act(() => {
        offEditor = r.result.current.registerEditor({
          templateId: 't',
          templateName: 'T',
          saved: () => saved,
          openTab,
        });
      });
      return { ...r, openTab, offEditor: () => act(() => offEditor()) };
    };

    it('документ смонтирован — run сразу и его результат', async () => {
      const { result } = setup();
      const a = adapter();
      act(() => {
        result.current.registerDocument({ templateId: 't', adapter: a, editable: () => true });
      });
      expect(result.current.document?.templateId).toBe('t');
      const run = vi.fn(async (x: DocumentAdapter) => (x === a ? 'done' : 'wrong'));
      await expect(result.current.applyDocument('t', run)).resolves.toBe('done');
    });

    it('документа нет — открыть вкладку «Документ», run после регистрации', async () => {
      const { result, openTab } = setup();
      const run = vi.fn(async () => 'done');
      let res: unknown;
      await act(async () => {
        res = await result.current.applyDocument('t', run);
      });
      expect(res).toBe('opened');
      expect(openTab).toHaveBeenCalledWith('document');
      expect(run).not.toHaveBeenCalled();
      const a = adapter();
      await act(async () => {
        result.current.registerDocument({ templateId: 't', adapter: a, editable: () => true });
      });
      expect(run).toHaveBeenCalledTimes(1);
      expect(run).toHaveBeenCalledWith(a, expect.any(Function));
      expect(result.current.documentAutomation).toBe('t');
    });

    it('другая вкладка с правками — queued без переключения; run после регистрации документа', async () => {
      const { result, openTab } = setup();
      act(() => {
        result.current.registerDirty(() => true);
      });
      const run = vi.fn(async () => 'done');
      await expect(result.current.applyDocument('t', run)).resolves.toBe('queued');
      expect(openTab).not.toHaveBeenCalled();
      await act(async () => {
        result.current.registerDocument({
          templateId: 't',
          adapter: adapter(),
          editable: () => true,
        });
      });
      expect(run).toHaveBeenCalledTimes(1);
    });

    it('clearPending сбрасывает отложенные run документа', async () => {
      const { result } = setup();
      const run = vi.fn(async () => 'done');
      await act(async () => {
        await result.current.applyDocument('t', run);
      });
      result.current.clearPending();
      await act(async () => {
        result.current.registerDocument({
          templateId: 't',
          adapter: adapter(),
          editable: () => true,
        });
      });
      expect(run).not.toHaveBeenCalled();
    });

    it('карточка другого шаблона или редактор закрыт — null', async () => {
      const { result, offEditor } = setup();
      await expect(result.current.applyDocument('other', vi.fn())).resolves.toBeNull();
      offEditor();
      await expect(result.current.applyDocument('t', vi.fn())).resolves.toBeNull();
    });

    it('snapshot(): без документа undefined; с документом — снимок; ошибка — undefined', async () => {
      const { result } = setup();
      await expect(result.current.snapshot()).resolves.toBeUndefined();
      let off = () => {};
      act(() => {
        off = result.current.registerDocument({
          templateId: 't',
          adapter: adapter(),
          editable: () => true,
        });
      });
      await expect(result.current.snapshot()).resolves.toEqual(snap);
      act(() => off());
      act(() => {
        result.current.registerDocument({
          templateId: 't',
          adapter: adapter({ snapshot: vi.fn(async () => Promise.reject(new Error('x'))) }),
          editable: () => true,
        });
      });
      await expect(result.current.snapshot()).resolves.toBeUndefined();
    });

    it('снятие регистрации сбрасывает document; признак возможности держится до закрытия редактора', async () => {
      const { result, offEditor } = setup();
      expect(result.current.documentAutomation).toBeNull();
      let off = () => {};
      act(() => {
        off = result.current.registerDocument({
          templateId: 't',
          adapter: adapter(),
          editable: () => true,
        });
      });
      act(() => off());
      expect(result.current.document).toBeNull();
      await expect(result.current.snapshot()).resolves.toBeUndefined();
      // Вкладка «Документ» размонтирована, но возможность в этой сессии редактора уже подтверждена.
      expect(result.current.documentAutomation).toBe('t');
      // Редактор закрыт (уход со страницы): TemplateEditorPage вызывает clearPending.
      offEditor();
      act(() => result.current.clearPending());
      expect(result.current.documentAutomation).toBeNull();
    });

    it('перерегистрация редактора без смонтированного документа сохраняет признак; другой шаблон и clearPending — сбрасывают', () => {
      const { result, offEditor } = setup();
      let off = () => {};
      act(() => {
        off = result.current.registerDocument({
          templateId: 't',
          adapter: adapter(),
          editable: () => true,
        });
      });
      act(() => off());
      // Сохранение на вкладке «Данные»: шаблон обновился, редактор перерегистрировался.
      offEditor();
      const reg = (templateId: string) =>
        act(() => {
          result.current.registerEditor({
            templateId,
            templateName: 'T',
            saved: () => saved,
            openTab: vi.fn(),
          });
        });
      reg('t');
      expect(result.current.documentAutomation).toBe('t');
      act(() => result.current.clearPending());
      expect(result.current.documentAutomation).toBeNull();
      act(() => {
        result.current.registerDocument({
          templateId: 't',
          adapter: adapter(),
          editable: () => true,
        });
      });
      reg('t2');
      expect(result.current.documentAutomation).toBeNull();
    });

    it('снимок не пришёл за 3 с — snapshot() undefined', async () => {
      vi.useFakeTimers();
      try {
        const { result } = setup();
        act(() => {
          result.current.registerDocument({
            templateId: 't',
            adapter: adapter({ snapshot: vi.fn(() => new Promise<DocSnapshot>(() => {})) }),
            editable: () => true,
          });
        });
        const p = result.current.snapshot();
        await vi.advanceTimersByTimeAsync(3_000);
        await expect(p).resolves.toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });

    it('перерегистрация редактора при смонтированном документе сохраняет признак возможности', () => {
      const { result, offEditor } = setup();
      act(() => {
        result.current.registerDocument({
          templateId: 't',
          adapter: adapter(),
          editable: () => true,
        });
      });
      // Шаблон обновился с сервера: редактор снимает регистрацию и регистрируется заново.
      offEditor();
      act(() => {
        result.current.registerEditor({
          templateId: 't',
          templateName: 'T',
          saved: () => saved,
          openTab: vi.fn(),
        });
      });
      expect(result.current.documentAutomation).toBe('t');
    });
  });
});
