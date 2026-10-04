import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { useStoredState } from './storage';

describe('useStoredState', () => {
  beforeEach(() => localStorage.clear());

  it('при смене ключа читает значение нового ключа и пишет только в него', () => {
    localStorage.setItem('k1', JSON.stringify('one'));
    localStorage.setItem('k2', JSON.stringify('two'));
    const { result, rerender } = renderHook(({ k }) => useStoredState(k, 'fb'), {
      initialProps: { k: 'k1' },
    });
    expect(result.current[0]).toBe('one');
    rerender({ k: 'k2' });
    expect(result.current[0]).toBe('two');
    act(() => result.current[1]('new'));
    expect(result.current[0]).toBe('new');
    expect(localStorage.getItem('k2')).toBe('"new"');
    expect(localStorage.getItem('k1')).toBe('"one"');
  });

  it('нет сохранённого значения — fallback', () => {
    const { result } = renderHook(() => useStoredState('none', 7));
    expect(result.current[0]).toBe(7);
  });
});
