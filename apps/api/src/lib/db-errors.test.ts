import { describe, expect, it } from 'vitest';
import { isForeignKeyViolation, isUniqueViolation } from './db-errors';

describe('db-errors', () => {
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
