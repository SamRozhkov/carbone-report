import { describe, expect, it } from 'vitest';
import { ApiRequestError } from './client';
import { errorMessage, fieldErrors } from './errors';

describe('fieldErrors', () => {
  it('форма {fields} (параметры отчёта)', () => {
    const e = new ApiRequestError(400, 'VALIDATION', 'неверные параметры', {
      fields: { from: 'обязательный параметр' },
    });
    expect(fieldErrors(e)).toEqual({ from: 'обязательный параметр' });
  });
  it('форма [{path,message}] (схема запроса), включая элементы массива', () => {
    const e = new ApiRequestError(400, 'VALIDATION', 'неверные данные запроса', [
      { path: '/login', message: 'Слишком короткое значение' },
      { path: '/0/name', message: 'имя: латиница, цифры и _' },
      { path: '/0/name', message: 'второе сообщение не перетирает первое' },
      { path: '', message: 'ошибка тела целиком' },
    ]);
    expect(fieldErrors(e)).toEqual({
      login: 'Слишком короткое значение',
      '0.name': 'имя: латиница, цифры и _',
      _: 'ошибка тела целиком',
    });
  });
  it('не VALIDATION → пусто', () => {
    expect(fieldErrors(new ApiRequestError(500, 'INTERNAL', 'x'))).toEqual({});
    expect(fieldErrors(new Error('x'))).toEqual({});
  });
});

describe('errorMessage', () => {
  it('берёт message из ApiRequestError и Error', () => {
    expect(
      errorMessage(new ApiRequestError(409, 'CONFLICT', 'источник используется шаблонами')),
    ).toBe('источник используется шаблонами');
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage('x')).toBe('неизвестная ошибка');
  });
});
