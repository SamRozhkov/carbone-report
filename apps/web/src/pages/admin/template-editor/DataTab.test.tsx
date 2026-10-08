import type { TemplateAdminDetails } from '@carbone-reports/shared';
import { screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, renderWithProviders } from '../../../test/utils';
import { DataTab } from './DataTab';
import { adminTemplate } from '../../../test/fixtures';

const t = {
  ...adminTemplate,
  params: [
    {
      name: 'limit',
      label: 'Лимит',
      type: 'number',
      required: false,
      defaultValue: 2,
      options: null,
    },
  ],
  queries: [
    { key: 'company', mode: 'single', sql: 'select 1 as name' },
    { key: 'orders', mode: 'list', sql: 'select id from orders limit :limit' },
  ],
} as TemplateAdminDetails;

const props = {
  template: t,
  testParams: { limit: 2 },
  onTestParams: () => {},
  previewData: null,
  onPreviewData: () => {},
};

describe('DataTab', () => {
  it('выполнение запроса с тестовыми параметрами и показ строк', async () => {
    const { calls } = mockApi([
      {
        method: 'POST',
        path: '/api/templates/t1/queries/run',
        body: {
          columns: ['id', 'meta'],
          rows: [
            { id: 1, meta: { a: 1 } },
            { id: 2, meta: null },
          ],
          truncated: true,
        },
      },
    ]);
    renderWithProviders(<DataTab {...props} />);
    await userEvent.click(await screen.findByRole('button', { name: /orders/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Выполнить' }));
    expect(await screen.findByText('{"a":1}')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.getByText(/первые 50 строк/)).toBeInTheDocument();
    expect(calls[0]!.body).toEqual({
      sql: 'select id from orders limit :limit',
      params: { limit: 2 },
    });
  });

  it('правка и сохранение запросов; ошибка у поля ключа', async () => {
    let attempt = 0;
    const { calls } = mockApi([
      {
        method: 'PUT',
        path: '/api/templates/t1/queries',
        handler: ({ body }) =>
          ++attempt === 1
            ? {
                status: 400,
                body: {
                  error: {
                    code: 'VALIDATION',
                    message: 'неверные данные запроса',
                    details: [{ path: '/0/key', message: 'ключ "params" зарезервирован' }],
                  },
                },
              }
            : { body: { ...t, queries: body } },
      },
    ]);
    renderWithProviders(<DataTab {...props} />);
    const key = await screen.findByLabelText('Ключ запроса');
    await userEvent.clear(key);
    await userEvent.type(key, 'params');
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить запросы' }));
    expect(await screen.findByText('ключ "params" зарезервирован')).toBeInTheDocument();

    await userEvent.clear(key);
    await userEvent.type(key, 'firm');
    const sql = screen.getByLabelText('SQL');
    await userEvent.clear(sql);
    await userEvent.type(sql, 'select 2');
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить запросы' }));
    await waitFor(() => expect(attempt).toBe(2));
    expect(calls.at(-1)!.body).toEqual([
      { key: 'firm', mode: 'single', sql: 'select 2' },
      { key: 'orders', mode: 'list', sql: 'select id from orders limit :limit' },
    ]);
  });

  it('добавление запроса с уникальным ключом и удаление', async () => {
    const { calls } = mockApi([
      {
        method: 'PUT',
        path: '/api/templates/t1/queries',
        handler: ({ body }) => ({ body: { ...t, queries: body } }),
      },
    ]);
    renderWithProviders(<DataTab {...props} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Добавить запрос' }));
    expect(screen.getByLabelText('Ключ запроса')).toHaveValue('query1');
    await userEvent.click(screen.getByRole('button', { name: /company/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Удалить запрос' }));
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить запросы' }));
    await waitFor(() => expect(calls.length).toBe(1));
    expect((calls[0]!.body as { key: string }[]).map((q) => q.key)).toEqual(['orders', 'query1']);
  });

  const validation = (details: unknown) => ({
    status: 400,
    body: { error: { code: 'VALIDATION', message: 'неверные данные запроса', details } },
  });

  it('ошибка у невыбранного запроса видна в списке и под формой', async () => {
    mockApi([
      {
        method: 'PUT',
        path: '/api/templates/t1/queries',
        handler: () => validation([{ path: '/1/sql', message: 'sql пустой' }]),
      },
    ]);
    renderWithProviders(<DataTab {...props} />);
    await screen.findByLabelText('Ключ запроса');
    await userEvent.type(screen.getByLabelText('SQL'), ' ');
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить запросы' }));
    expect(await screen.findByText(/Запрос «orders»: sql пустой/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /orders.*ошибка/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /company/ })).not.toHaveTextContent('ошибка');
  });

  it('результат выполнения сбрасывается при смене выбранного запроса', async () => {
    mockApi([
      {
        method: 'POST',
        path: '/api/templates/t1/queries/run',
        body: { columns: ['id'], rows: [{ id: 7 }], truncated: false },
      },
    ]);
    renderWithProviders(<DataTab {...props} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Выполнить' }));
    expect(await screen.findByText('Результат запроса «company»')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /orders/ }));
    expect(screen.queryByText(/Результат запроса/)).not.toBeInTheDocument();
    expect(screen.queryByText('7')).not.toBeInTheDocument();
  });

  it('без изменений сохранить нельзя; «Отменить» возвращает сохранённые запросы', async () => {
    mockApi([]);
    renderWithProviders(<DataTab {...props} />);
    const save = () => screen.getByRole('button', { name: 'Сохранить запросы' });
    await screen.findByLabelText('SQL');
    expect(save()).toBeDisabled();
    await userEvent.type(screen.getByLabelText('SQL'), 'X');
    await userEvent.click(screen.getByRole('button', { name: 'Добавить запрос' }));
    expect(save()).toBeEnabled();
    expect(screen.getByText('Есть несохранённые изменения')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Отменить' }));
    expect(screen.queryByRole('button', { name: /query1/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /company/ }));
    expect(screen.getByLabelText('SQL')).toHaveValue('select 1 as name');
    expect(save()).toBeDisabled();
  });

  describe('обновление шаблона', () => {
    const newer = {
      ...t,
      updatedAt: '2026-02-01T00:00:00Z',
      queries: [{ key: 'other', mode: 'list', sql: 'select 9' }],
    } as TemplateAdminDetails;
    function Harness() {
      const [tpl, setTpl] = useState(t);
      return (
        <>
          <button onClick={() => setTpl(newer)}>refresh</button>
          <DataTab {...props} template={tpl} />
        </>
      );
    }

    it('несохранённый черновик сохраняется, показывается предупреждение', async () => {
      mockApi([]);
      renderWithProviders(<Harness />);
      await userEvent.type(await screen.findByLabelText('SQL'), 'X');
      await userEvent.click(screen.getByRole('button', { name: 'refresh' }));
      expect(screen.getByLabelText('SQL')).toHaveValue('select 1 as nameX');
      expect(screen.getByLabelText('Ключ запроса')).toHaveValue('company');
      expect(screen.getByText(/Шаблон изменился на сервере/)).toBeInTheDocument();
    });

    it('чистый черновик подхватывает новый шаблон', async () => {
      mockApi([]);
      renderWithProviders(<Harness />);
      await screen.findByLabelText('SQL');
      await userEvent.click(screen.getByRole('button', { name: 'refresh' }));
      expect(screen.getByLabelText('Ключ запроса')).toHaveValue('other');
      expect(screen.queryByText(/Шаблон изменился на сервере/)).not.toBeInTheDocument();
    });
  });
});
