import type { TemplateAdminDetails } from '@carbone-reports/shared';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, renderWithProviders } from '../../../test/utils';
import { ParamsTab } from './ParamsTab';
import { adminTemplate } from '../../../test/fixtures';

const t = {
  ...adminTemplate,
  params: [
    {
      name: 'from',
      label: 'С даты',
      type: 'date',
      required: true,
      defaultValue: null,
      options: null,
    },
    {
      name: 'status',
      label: 'Статус',
      type: 'select',
      required: false,
      defaultValue: null,
      options: [{ value: 'new', label: 'Новый' }],
    },
  ],
} as TemplateAdminDetails;

describe('ParamsTab', () => {
  it('добавление параметра и варианты списка → PUT массива', async () => {
    const { calls } = mockApi([
      {
        method: 'PUT',
        path: '/api/templates/t1/params',
        handler: ({ body }) => ({ body: { ...t, params: body } }),
      },
    ]);
    renderWithProviders(<ParamsTab template={t} />);
    const options = await screen.findByLabelText('Варианты параметра 2');
    await userEvent.clear(options);
    await userEvent.type(options, 'new=Новый{enter}done=Готов');
    await userEvent.click(screen.getByRole('button', { name: 'Добавить параметр' }));
    const name3 = screen.getByLabelText('Имя параметра 3');
    await userEvent.clear(name3);
    await userEvent.type(name3, 'company');
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить параметры' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const body = calls.find((c) => c.method === 'PUT')!.body as {
      name: string;
      options: unknown;
    }[];
    expect(body.map((p) => p.name)).toEqual(['from', 'status', 'company']);
    expect(body[1]!.options).toEqual([
      { value: 'new', label: 'Новый' },
      { value: 'done', label: 'Готов' },
    ]);
    expect(body[2]).toMatchObject({ type: 'string', options: null, required: false });
  });

  it('ошибки сервера: по индексу строки и по имени параметра (default)', async () => {
    let attempt = 0;
    mockApi([
      {
        method: 'PUT',
        path: '/api/templates/t1/params',
        handler: () =>
          ++attempt === 1
            ? {
                status: 400,
                body: {
                  error: {
                    code: 'VALIDATION',
                    message: 'неверные данные запроса',
                    details: [{ path: '/1/name', message: 'имя: латиница, цифры и _' }],
                  },
                },
              }
            : {
                status: 400,
                body: {
                  error: {
                    code: 'VALIDATION',
                    message: 'неверные параметры',
                    details: {
                      fields: { from: 'значение по умолчанию: ожидается дата ГГГГ-ММ-ДД' },
                    },
                  },
                },
              },
      },
    ]);
    renderWithProviders(<ParamsTab template={t} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Сохранить параметры' }));
    expect(await screen.findByText('имя: латиница, цифры и _')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить параметры' }));
    expect(
      await screen.findByText('значение по умолчанию: ожидается дата ГГГГ-ММ-ДД'),
    ).toBeInTheDocument();
  });

  it('удаление и перестановка', async () => {
    const { calls } = mockApi([
      {
        method: 'PUT',
        path: '/api/templates/t1/params',
        handler: ({ body }) => ({ body: { ...t, params: body } }),
      },
    ]);
    renderWithProviders(<ParamsTab template={t} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Выше: параметр 2' }));
    await userEvent.click(screen.getByRole('button', { name: 'Удалить параметр 2' }));
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить параметры' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(
      (calls.find((c) => c.method === 'PUT')!.body as { name: string }[]).map((p) => p.name),
    ).toEqual(['status']);
  });

  const validation = (details: unknown) => ({
    status: 400,
    body: { error: { code: 'VALIDATION', message: 'неверные данные запроса', details } },
  });

  it('ошибка вложенного пути /1/options/0/value показывается у вариантов строки 2', async () => {
    mockApi([
      {
        method: 'PUT',
        path: '/api/templates/t1/params',
        handler: () =>
          validation([{ path: '/1/options/0/value', message: 'значение не может быть пустым' }]),
      },
    ]);
    renderWithProviders(<ParamsTab template={t} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Сохранить параметры' }));
    const msg = await screen.findByText('значение не может быть пустым');
    expect(msg).toHaveAttribute('data-testid', 'field-error');
    expect(screen.getByLabelText('Варианты параметра 2').closest('label')).toContainElement(msg);
  });

  it('ошибка, не относящаяся ни к одному полю, остаётся видимой в общем блоке', async () => {
    mockApi([
      {
        method: 'PUT',
        path: '/api/templates/t1/params',
        handler: () => validation([{ path: '/7/name', message: 'нет такой строки' }]),
      },
    ]);
    renderWithProviders(<ParamsTab template={t} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Сохранить параметры' }));
    const msg = await screen.findByText(/7\.name: нет такой строки/);
    expect(msg).not.toHaveAttribute('data-testid', 'field-error');
  });

  it('после удаления строки поля не переиспользуются (стабильные ключи)', async () => {
    mockApi([]);
    renderWithProviders(<ParamsTab template={t} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Удалить параметр 1' }));
    expect(screen.getByLabelText('Имя параметра 1')).toHaveValue('status');
    expect(screen.queryByLabelText('Имя параметра 2')).not.toBeInTheDocument();
  });
});
