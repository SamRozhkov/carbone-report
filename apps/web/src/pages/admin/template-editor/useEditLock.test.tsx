import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockApi, wrapper } from '../../../test/utils';
import { useEditLock } from './useEditLock';

const other = {
  state: 'other',
  user: { id: 'u2', login: 'petrov' },
  since: '2026-10-15T10:00:00.000Z',
  sameUser: false,
};

describe('useEditLock', () => {
  beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => vi.useRealTimers());

  it('захват при открытии, продление раз в 20 с с acquire по режиму', async () => {
    const { calls } = mockApi([
      { method: 'POST', path: '/api/templates/t1/edit-lock', body: { state: 'mine' } },
      { method: 'DELETE', path: '/api/templates/t1/edit-lock', status: 204 },
    ]);
    const { result } = renderHook(() => useEditLock('t1'), { wrapper });
    await waitFor(() => expect(result.current.editing).toBe(true));
    expect(calls[0]!.body).toEqual({ holder: result.current.holder, acquire: true });
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(calls.filter((c) => c.path.endsWith('/edit-lock') && c.method === 'POST')).toHaveLength(
      2,
    );
    expect(calls.at(-1)!.body).toEqual({ holder: result.current.holder, acquire: true });
  });

  it('перехватили: lostTo, просмотр, продление с acquire: false', async () => {
    let n = 0;
    const { calls } = mockApi([
      {
        method: 'POST',
        path: '/api/templates/t1/edit-lock',
        handler: () => ({ body: n++ === 0 ? { state: 'mine' } : other }),
      },
      { method: 'DELETE', path: '/api/templates/t1/edit-lock', status: 204 },
    ]);
    const { result } = renderHook(() => useEditLock('t1'), { wrapper });
    await waitFor(() => expect(result.current.editing).toBe(true));
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    await waitFor(() => expect(result.current.lostTo).toBe('petrov'));
    expect(result.current.editing).toBe(false);
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(calls.at(-1)!.body).toMatchObject({ acquire: false });
  });

  it('первый вызов не удался: продление идёт с acquire: true, пока нет ответа', async () => {
    let n = 0;
    const { calls } = mockApi([
      {
        method: 'POST',
        path: '/api/templates/t1/edit-lock',
        handler: () =>
          n++ === 0
            ? { status: 500, body: { error: { code: 'X', message: 'x' } } }
            : { body: { state: 'mine' } },
      },
      { method: 'DELETE', path: '/api/templates/t1/edit-lock', status: 204 },
    ]);
    const { result } = renderHook(() => useEditLock('t1'), { wrapper });
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(result.current.state).toBeNull();
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(calls[1]!.body).toEqual({ holder: result.current.holder, acquire: true });
    await waitFor(() => expect(result.current.editing).toBe(true));
  });

  it('enabled=false: блокировка не берётся', async () => {
    const { calls } = mockApi([
      { method: 'POST', path: '/api/templates/t1/edit-lock', body: { state: 'mine' } },
      { method: 'DELETE', path: '/api/templates/t1/edit-lock', status: 204 },
    ]);
    const { result } = renderHook(() => useEditLock('t1', false), { wrapper });
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(calls).toHaveLength(0);
    expect(result.current.state).toBeNull();
  });

  it('три ошибки подряд — offline; успех снимает', async () => {
    let fail = false;
    mockApi([
      {
        method: 'POST',
        path: '/api/templates/t1/edit-lock',
        handler: () =>
          fail
            ? { status: 500, body: { error: { code: 'X', message: 'x' } } }
            : { body: { state: 'mine' } },
      },
      { method: 'DELETE', path: '/api/templates/t1/edit-lock', status: 204 },
    ]);
    const { result } = renderHook(() => useEditLock('t1'), { wrapper });
    await waitFor(() => expect(result.current.editing).toBe(true));
    fail = true;
    for (let i = 0; i < 2; i++) await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(result.current.offline).toBe(false);
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(result.current.offline).toBe(true);
    expect(result.current.editing).toBe(true); // редактор не пересоздаётся
    fail = false;
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(result.current.offline).toBe(false);
  });

  it('takeover и start; освобождение при размонтировании и pagehide', async () => {
    const { calls } = mockApi([
      { method: 'POST', path: '/api/templates/t1/edit-lock', body: other },
      { method: 'POST', path: '/api/templates/t1/edit-lock/takeover', body: { state: 'mine' } },
      { method: 'DELETE', path: '/api/templates/t1/edit-lock', status: 204 },
    ]);
    const { result, unmount } = renderHook(() => useEditLock('t1'), { wrapper });
    await waitFor(() => expect(result.current.state).toEqual(other));
    await act(() => result.current.takeover());
    expect(result.current.editing).toBe(true);
    window.dispatchEvent(new Event('pagehide'));
    unmount();
    const dels = calls.filter((c) => c.method === 'DELETE');
    expect(dels.length).toBeGreaterThanOrEqual(1);
    expect(dels[0]!.path).toBe(`/api/templates/t1/edit-lock?holder=${result.current.holder}`);
  });
});
