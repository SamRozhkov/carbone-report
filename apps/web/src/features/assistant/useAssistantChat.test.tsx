import type { DocSnapshot } from '@carbone-reports/shared';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi, wrapper as TestProviders } from '../../test/utils';
import { AssistantBridgeProvider, useAssistantBridge } from './bridge';
import type { DocumentAdapter } from './documentAdapter';
import { useAssistantChat } from './useAssistantChat';

const Wrapper = ({ children }: { children: ReactNode }) => (
  <TestProviders>
    <MemoryRouter initialEntries={['/admin/templates/t1/edit']}>
      <AssistantBridgeProvider>{children}</AssistantBridgeProvider>
    </MemoryRouter>
  </TestProviders>
);

const snap: DocSnapshot = { blocks: [{ type: 'p', text: 'Счёт', area: 'body' }], truncated: false };
const adapter = (snapshot: () => Promise<DocSnapshot>): DocumentAdapter => ({
  snapshot: vi.fn(snapshot),
  insertTags: vi.fn(),
  insertTable: vi.fn(),
  replaceAll: vi.fn(),
  replace: vi.fn(),
  dispose: vi.fn(),
});
const saved = { queries: [], params: [] };

type Editor = { document?: unknown; documentAutomation?: unknown };

async function send(setup: (b: ReturnType<typeof useAssistantBridge>) => void) {
  const { calls } = mockApi([
    { method: 'POST', path: '/api/assistant/chat', body: { reply: 'ok', cards: [] } },
  ]);
  const { result } = renderHook(
    () => ({ chat: useAssistantChat(), bridge: useAssistantBridge() }),
    { wrapper: Wrapper },
  );
  act(() => {
    result.current.bridge.registerEditor({
      templateId: 't1',
      templateName: 'T',
      saved: () => saved,
      openTab: vi.fn(),
    });
    setup(result.current.bridge);
  });
  act(() => result.current.chat.send('сделай шаблон'));
  // Зависший снимок ждём до 3 с (bridge.snapshot), затем запрос уходит без него.
  await waitFor(() => expect(calls.some((c) => c.path === '/api/assistant/chat')).toBe(true), {
    timeout: 5_000,
  });
  const body = calls.find((c) => c.path === '/api/assistant/chat')!.body as {
    page: { templateId?: string; editor?: Editor };
  };
  await waitFor(() => expect(result.current.chat.pending).toBe(false));
  return body.page;
}

beforeEach(() => sessionStorage.clear());

describe('useAssistantChat: снимок документа (§52.3)', () => {
  it('документ шаблона зарегистрирован — document и documentAutomation: true', async () => {
    const page = await send((b) => {
      b.registerDocument({
        templateId: 't1',
        adapter: adapter(async () => snap),
        editable: () => true,
      });
    });
    expect(page.templateId).toBe('t1');
    expect(page.editor).toEqual({ ...saved, document: snap, documentAutomation: true });
  });

  it('документа нет — без document и documentAutomation', async () => {
    const page = await send(() => {});
    expect(page.editor).toEqual(saved);
  });

  it('документ другого шаблона — без снимка', async () => {
    const page = await send((b) => {
      b.registerDocument({
        templateId: 't2',
        adapter: adapter(async () => snap),
        editable: () => true,
      });
    });
    expect(page.editor).toEqual(saved);
  });

  it('снимок не получился — без обоих полей', async () => {
    const page = await send((b) => {
      b.registerDocument({
        templateId: 't1',
        adapter: adapter(() => Promise.reject(new Error('connector'))),
        editable: () => true,
      });
    });
    expect(page.editor).toEqual(saved);
  });

  it('снимок завис — запрос уходит без document и documentAutomation', async () => {
    const page = await send((b) => {
      b.registerDocument({
        templateId: 't1',
        adapter: adapter(() => new Promise<DocSnapshot>(() => {})),
        editable: () => true,
      });
    });
    expect(page.editor).toEqual(saved);
  }, 10_000);
});
