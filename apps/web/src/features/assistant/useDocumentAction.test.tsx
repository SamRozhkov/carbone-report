import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { wrapper as TestProviders } from '../../test/utils';
import { AssistantBridgeProvider, useAssistantBridge } from './bridge';
import type { DocumentAdapter } from './documentAdapter';
import type { SheetAdapter } from './sheetAdapter';
import { useDocumentAction, useSheetAction } from './useDocumentAction';

const Wrapper = ({ children }: { children: ReactNode }) => (
  <TestProviders>
    <AssistantBridgeProvider>{children}</AssistantBridgeProvider>
  </TestProviders>
);

const sheet = (): SheetAdapter => ({
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
});
const doc = (): DocumentAdapter => ({
  snapshot: vi.fn(async () => ({ blocks: [], truncated: false })),
  insertTags: vi.fn(async () => {}),
  insertTable: vi.fn(async () => {}),
  replaceAll: vi.fn(async () => {}),
  replace: vi.fn(async () => ({ notFound: { items: [], tables: [] } })),
  dispose: vi.fn(),
});

function setup(fileExt: string | undefined) {
  const r = renderHook(
    () => ({
      bridge: useAssistantBridge(),
      doc: useDocumentAction('t1'),
      sheet: useSheetAction('t1'),
    }),
    { wrapper: Wrapper },
  );
  act(() => {
    r.result.current.bridge.registerEditor({
      templateId: 't1',
      templateName: 'T',
      fileExt,
      saved: () => ({ queries: [], params: [] }),
      openTab: vi.fn(),
    });
  });
  return r;
}

describe('useFormingAction: вид формирования по расширению шаблона (§53.4)', () => {
  it('xlsx с листом — видны действия листа, действия документа скрыты', async () => {
    const { result } = setup('xlsx');
    const a = sheet();
    act(() => {
      result.current.bridge.registerSheet({ templateId: 't1', adapter: a, editable: () => true });
    });
    expect(result.current.sheet.visible).toBe(true);
    expect(result.current.doc.visible).toBe(false);
    const action = vi.fn(async (x: SheetAdapter) => {
      expect(x).toBe(a);
    });
    act(() => result.current.sheet.run(action));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.sheet.busy).toBe(false));
  });

  it('ods только для просмотра — действия листа неактивны', () => {
    const { result } = setup('ods');
    act(() => {
      result.current.bridge.registerSheet({
        templateId: 't1',
        adapter: sheet(),
        editable: () => false,
      });
    });
    expect(result.current.sheet.visible).toBe(true);
    expect(result.current.sheet.readOnly).toBe(true);
  });

  it('docx с документом — как на этапе 3: видны действия документа, листа — нет', () => {
    const { result } = setup('docx');
    act(() => {
      result.current.bridge.registerDocument({
        templateId: 't1',
        adapter: doc(),
        editable: () => true,
      });
    });
    expect(result.current.doc.visible).toBe(true);
    expect(result.current.sheet.visible).toBe(false);
  });

  it('расширение не передано — текстовый шаблон', () => {
    const { result } = setup(undefined);
    act(() => {
      result.current.bridge.registerDocument({
        templateId: 't1',
        adapter: doc(),
        editable: () => true,
      });
    });
    expect(result.current.doc.visible).toBe(true);
    expect(result.current.sheet.visible).toBe(false);
  });
});
