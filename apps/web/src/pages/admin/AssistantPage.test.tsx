import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { adminMe, mockApi, renderRoute } from '../../test/utils';

const saved = {
  enabled: true,
  baseUrl: 'http://llm/v1',
  model: 'm1',
  hasApiKey: true,
  extraInstructions: '',
};

describe('AssistantPage', () => {
  it('ключ задан: сохранение без поля apiKey; проверка без ключа', async () => {
    const { calls } = mockApi([
      adminMe,
      { path: '/api/admin/assistant', body: saved },
      { method: 'POST', path: '/api/admin/assistant/test', body: { ok: true } },
      { method: 'PUT', path: '/api/admin/assistant', status: 204 },
    ]);
    renderRoute('/admin/assistant');
    expect(await screen.findByText('Ключ задан')).toBeInTheDocument();
    expect(screen.getByText(/передаются провайдеру модели/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Проверить подключение' }));
    expect(
      await screen.findByText('Модель отвечает, вызов инструментов поддерживается'),
    ).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/api/admin/assistant/test')?.body).toEqual({
      baseUrl: 'http://llm/v1',
      model: 'm1',
    });
    const model = screen.getByLabelText('Модель');
    await userEvent.clear(model);
    await userEvent.type(model, 'm2');
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
        enabled: true,
        baseUrl: 'http://llm/v1',
        model: 'm2',
        extraInstructions: '',
      }),
    );
  });

  it('замена ключа уходит в apiKey; ошибка проверки показывается текстом', async () => {
    const { calls } = mockApi([
      adminMe,
      { path: '/api/admin/assistant', body: saved },
      {
        method: 'POST',
        path: '/api/admin/assistant/test',
        body: {
          ok: false,
          code: 'auth',
          message: 'Провайдер модели отклонил ключ. Обратитесь к администратору',
        },
      },
    ]);
    renderRoute('/admin/assistant');
    await userEvent.click(await screen.findByRole('button', { name: 'Заменить' }));
    await userEvent.type(screen.getByLabelText('Ключ API'), 'sk-new');
    await userEvent.click(screen.getByRole('button', { name: 'Проверить подключение' }));
    expect(await screen.findByText(/отклонил ключ/)).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/api/admin/assistant/test')?.body).toMatchObject({
      apiKey: 'sk-new',
    });
  });

  it('ошибка сохранения по полю показывается у поля', async () => {
    mockApi([
      adminMe,
      { path: '/api/admin/assistant', body: { ...saved, enabled: false, baseUrl: '', model: '' } },
      {
        method: 'PUT',
        path: '/api/admin/assistant',
        status: 400,
        body: {
          error: {
            code: 'VALIDATION',
            message: 'Ошибка',
            details: [{ path: '/model', message: 'укажите модель' }],
          },
        },
      },
    ]);
    renderRoute('/admin/assistant');
    await userEvent.click(await screen.findByRole('switch', { name: 'Ассистент включён' }));
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
    expect(await screen.findByText('укажите модель')).toBeInTheDocument();
  });
});
