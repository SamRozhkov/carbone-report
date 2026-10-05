import type { TemplateAdminDetails } from '@carbone-reports/shared';
import { useState } from 'react';
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

const newer = {
  ...t,
  updatedAt: '2026-02-01T00:00:00Z',
  params: [{ ...t.params[0]!, name: 'other' }],
} as TemplateAdminDetails;

function Harness({ initial, next }: { initial: TemplateAdminDetails; next: TemplateAdminDetails }) {
  const [tpl, setTpl] = useState(initial);
  return (
    <>
      <button onClick={() => setTpl(next)}>refresh</button>
      <ParamsTab template={tpl} />
    </>
  );
}

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

  it('после удаления строки DOM-узлы строк не переиспользуются (стабильные ключи)', async () => {
    mockApi([]);
    renderWithProviders(<ParamsTab template={t} />);
    const row2Input = await screen.findByLabelText('Имя параметра 2');
    await userEvent.click(screen.getByRole('button', { name: 'Удалить параметр 1' }));
    expect(screen.getByLabelText('Имя параметра 1')).toBe(row2Input);
  });

  it('грязный черновик сохраняется при обновлении шаблона, показывается предупреждение', async () => {
    mockApi([]);
    renderWithProviders(<Harness initial={t} next={newer} />);
    await userEvent.type(await screen.findByLabelText('Имя параметра 1'), 'X');
    await userEvent.click(screen.getByRole('button', { name: 'refresh' }));
    expect(screen.getByLabelText('Имя параметра 1')).toHaveValue('fromX');
    expect(screen.getByText(/Шаблон изменился на сервере/)).toBeInTheDocument();
  });

  it('чистый черновик подхватывает новый шаблон', async () => {
    mockApi([]);
    renderWithProviders(<Harness initial={t} next={newer} />);
    await screen.findByLabelText('Имя параметра 1');
    await userEvent.click(screen.getByRole('button', { name: 'refresh' }));
    expect(screen.getByLabelText('Имя параметра 1')).toHaveValue('other');
    expect(screen.queryByLabelText('Имя параметра 2')).not.toBeInTheDocument();
    expect(screen.queryByText(/Шаблон изменился на сервере/)).not.toBeInTheDocument();
  });

  it('тип «SQL-список»: поле SQL, флажок, «зависит от»; PUT уходит с sql и multiple', async () => {
    const { calls } = mockApi([
      {
        method: 'PUT',
        path: '/api/templates/t1/params',
        handler: ({ body }) => ({ body: { ...t, params: body } }),
      },
    ]);
    renderWithProviders(<ParamsTab template={t} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Добавить параметр' }));
    await userEvent.click(screen.getByRole('combobox', { name: 'Тип параметра 3' }));
    await userEvent.click(await screen.findByRole('option', { name: 'SQL-список' }));
    const sql = screen.getByLabelText('SQL параметра 3');
    await userEvent.type(sql, 'select id from c where r = :from and x::int = 1');
    expect(screen.getByText('зависит от: from')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: 'множественный выбор' }));
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить параметры' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const body = calls.find((c) => c.method === 'PUT')!.body as Record<string, unknown>[];
    expect(body[2]).toEqual({
      name: 'param3',
      label: 'Новый параметр',
      type: 'query',
      required: false,
      defaultValue: null,
      options: null,
      sql: 'select id from c where r = :from and x::int = 1',
      multiple: true,
    });
    expect(body[0]).toMatchObject({ sql: null, multiple: false });
    expect(body[0]).not.toHaveProperty('dependsOn');
  });

  const withQuery = {
    ...t,
    params: [
      { ...t.params[0]!, dependsOn: [] },
      {
        name: 'city',
        label: 'Город',
        type: 'query',
        required: false,
        defaultValue: null,
        options: null,
        sql: 'select id as value, name as label from city where d > :from',
        multiple: false,
        dependsOn: ['from'],
      },
    ],
  } as TemplateAdminDetails;

  it('ошибка сервера 1.sql показывается у поля SQL второй строки', async () => {
    mockApi([
      {
        method: 'PUT',
        path: '/api/templates/t1/params',
        handler: () => validation([{ path: '/1/sql', message: 'циклическая зависимость' }]),
      },
    ]);
    renderWithProviders(<ParamsTab template={withQuery} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Сохранить параметры' }));
    const msg = await screen.findByText('циклическая зависимость');
    expect(msg).toHaveAttribute('data-testid', 'field-error');
    expect(screen.getByLabelText('SQL параметра 2').closest('.cr-field')).toContainElement(msg);
  });

  it('после сохранения кэш вариантов SQL-списков шаблона сбрасывается', async () => {
    mockApi([
      {
        method: 'PUT',
        path: '/api/templates/t1/params',
        handler: ({ body }) => ({ body: { ...withQuery, params: body } }),
      },
    ]);
    const { queryClient } = renderWithProviders(<ParamsTab template={withQuery} />);
    const key = ['param-options', 't1', 'city', { from: '2026-01-01' }];
    queryClient.setQueryData(key, { options: [{ value: 1, label: 'Старый' }] });
    queryClient.setQueryData(['param-options', 't2', 'city', {}], { options: [] });
    expect(queryClient.getQueryState(key)?.isInvalidated).toBe(false);
    await userEvent.click(await screen.findByRole('button', { name: 'Сохранить параметры' }));
    await waitFor(() => expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true));
    expect(queryClient.getQueryState(['param-options', 't2', 'city', {}])?.isInvalidated).toBe(
      false,
    );
  });

  it('значение по умолчанию SQL-списка: пробелы по краям обрезаются при сохранении', async () => {
    const { calls } = mockApi([
      {
        method: 'PUT',
        path: '/api/templates/t1/params',
        handler: ({ body }) => ({ body: { ...withQuery, params: body } }),
      },
    ]);
    renderWithProviders(<ParamsTab template={withQuery} />);
    const input = await screen.findByRole('textbox', { name: 'По умолчанию' });
    await userEvent.type(input, ' 4 2 ');
    expect(input).toHaveValue('4 2 ');
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить параметры' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const body = calls.find((c) => c.method === 'PUT')!.body as Record<string, unknown>[];
    expect(body[1]).toMatchObject({ name: 'city', defaultValue: '4 2' });
  });

  it('«Проверить» выполняет options с тестовыми параметрами и показывает варианты', async () => {
    localStorage.setItem('cr-test-params-t1', JSON.stringify({ from: '2026-01-01' }));
    const { calls } = mockApi([
      {
        method: 'POST',
        path: '/api/templates/t1/params/city/options',
        body: {
          options: Array.from({ length: 25 }, (_, k) => ({
            value: k + 1,
            label: `Город ${k + 1}`,
          })),
        },
      },
    ]);
    renderWithProviders(<ParamsTab template={withQuery} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Проверить: параметр 2' }));
    expect(await screen.findByText(/всего вариантов: 25/)).toBeInTheDocument();
    expect(screen.getByText('Город 20 (20)')).toBeInTheDocument();
    expect(screen.queryByText('Город 21 (21)')).not.toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({
      params: { from: '2026-01-01', city: null },
    });
  });

  it('«Проверить»: ошибка сервера; несохранённый SQL — кнопка неактивна', async () => {
    mockApi([
      {
        method: 'POST',
        path: '/api/templates/t1/params/city/options',
        status: 400,
        body: { error: { code: 'SQL_ERROR', message: 'ошибка SQL: syntax error' } },
      },
    ]);
    renderWithProviders(<ParamsTab template={withQuery} />);
    const check = await screen.findByRole('button', { name: 'Проверить: параметр 2' });
    await userEvent.click(check);
    expect(await screen.findByText('ошибка SQL: syntax error')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('SQL параметра 2'), ' and 1=1');
    expect(screen.getByRole('button', { name: 'Проверить: параметр 2' })).toBeDisabled();
    expect(screen.getByText('сохраните параметры')).toBeInTheDocument();
  });
});
