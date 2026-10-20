import { describe, expect, it } from 'vitest';
import { isSignBlocked, SIGN_FAILURE_WINDOW_MS } from './password-failures';

const now = new Date('2026-10-20T12:00:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms);

describe('isSignBlocked (§39.8)', () => {
  it('нет строки или меньше пяти — не заблокировано', () => {
    expect(isSignBlocked(undefined, now)).toBe(false);
    expect(isSignBlocked({ count: 4, windowStart: ago(60_000) }, now)).toBe(false);
  });
  it('пять и окно идёт — заблокировано', () => {
    expect(isSignBlocked({ count: 5, windowStart: ago(60_000) }, now)).toBe(true);
    expect(isSignBlocked({ count: 9, windowStart: ago(SIGN_FAILURE_WINDOW_MS - 1) }, now)).toBe(
      true,
    );
  });
  it('окно закончилось (ровно 15 минут и позже) — не заблокировано', () => {
    expect(isSignBlocked({ count: 5, windowStart: ago(SIGN_FAILURE_WINDOW_MS) }, now)).toBe(false);
    expect(isSignBlocked({ count: 50, windowStart: ago(16 * 60_000) }, now)).toBe(false);
  });
});
