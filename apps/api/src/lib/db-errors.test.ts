import { describe, expect, it } from 'vitest';
import { isForeignKeyViolation, isLockTimeout, isUniqueViolation } from './db-errors';

describe('db-errors', () => {
  it('isLockTimeout узнаёт 55P03 в самой ошибке и в cause', () => {
    expect(isLockTimeout({ code: '55P03' })).toBe(true);
    expect(isLockTimeout({ cause: { code: '55P03' } })).toBe(true);
    expect(isLockTimeout({ code: '57014' })).toBe(false);
    expect(isLockTimeout(null)).toBe(false);
  });
  it('isForeignKeyViolation узнаёт 23503 в самой ошибке и в cause', () => {
    expect(isForeignKeyViolation({ code: '23503' })).toBe(true);
    expect(isForeignKeyViolation({ cause: { code: '23503' } })).toBe(true);
    expect(isForeignKeyViolation({ code: '23505' })).toBe(false);
    expect(isForeignKeyViolation(null)).toBe(false);
    expect(isForeignKeyViolation(new Error('x'))).toBe(false);
  });
  it('isUniqueViolation не путает коды', () => {
    expect(isUniqueViolation({ cause: { code: '23505' } })).toBe(true);
    expect(isUniqueViolation({ code: '23503' })).toBe(false);
  });
});
