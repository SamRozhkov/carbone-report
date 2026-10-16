import { describe, expect, it } from 'vitest';
import {
  EditLockBody,
  EditLockHolderQuery,
  EditLockState,
  EditLockTakeoverBody,
} from './edit-lock';

const holder = '0b6c6f0e-2b4c-4a51-9a39-1f4b2a3c4d5e';

describe('edit-lock', () => {
  it('тело захвата: holder — UUID, acquire — boolean', () => {
    expect(EditLockBody.parse({ holder, acquire: true })).toEqual({ holder, acquire: true });
    expect(EditLockBody.safeParse({ holder: 'x', acquire: true }).success).toBe(false);
    expect(EditLockBody.safeParse({ holder }).success).toBe(false);
    expect(EditLockTakeoverBody.safeParse({ holder }).success).toBe(true);
    expect(EditLockHolderQuery.safeParse({ holder: '' }).success).toBe(false);
  });
  it('состояния', () => {
    expect(EditLockState.parse({ state: 'mine' })).toEqual({ state: 'mine' });
    expect(EditLockState.parse({ state: 'free' })).toEqual({ state: 'free' });
    const other = {
      state: 'other',
      user: { id: 'u1', login: 'ivanov' },
      since: '2026-10-15T10:00:00.000Z',
      sameUser: false,
    };
    expect(EditLockState.parse(other)).toEqual(other);
    expect(EditLockState.safeParse({ state: 'other' }).success).toBe(false);
  });
});
