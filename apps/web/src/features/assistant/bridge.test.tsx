import type { TemplateParam } from '@carbone-reports/shared';
import { act, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
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
    act(() => result.current.apply(qcard));
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
      });
    });
    result.current.apply(qcard);
    expect(apply).toHaveBeenCalledWith(qcard);
    expect(result.current.draft()!.queries).toEqual([
      { key: 'x', mode: 'single', sql: 'select 3' },
    ]);
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
});
