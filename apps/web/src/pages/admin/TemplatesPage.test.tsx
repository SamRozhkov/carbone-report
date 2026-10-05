import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { adminMe, mockApi, renderRoute } from '../../test/utils';

const ds = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    name: 'Склад',
    host: 'db',
    port: 5432,
    database: 'wh',
    username: 'ro',
    sslMode: 'disable',
    sslCa: null,
    createdAt: '2026-01-01T00:00:00Z',
  },
];
const tpl = {
  id: 't1',
  name: 'Счёт',
  description: 'Счёт на оплату',
  fileExt: 'docx',
  defaultOutput: 'pdf',
  updatedAt: '2026-01-10T10:00:00Z',
};

describe('TemplatesPage', () => {
  it('создание пустого DOCX → POST JSON и переход в редактор', async () => {
    const { calls } = mockApi([
      adminMe,
      { path: '/api/templates', body: [] },
      { path: '/api/datasources', body: ds },
      { method: 'POST', path: '/api/templates', status: 201, body: { ...tpl, id: 'new-id' } },
    ]);
    const { router } = renderRoute('/admin/templates');
    await userEvent.click(await screen.findByRole('button', { name: 'Создать шаблон' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Название'), 'Счёт');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Создать' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/admin/templates/new-id'));
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      name: 'Счёт',
      description: '',
      datasourceId: ds[0]!.id,
      blank: 'docx',
    });
  });

  it('загрузка файла → multipart с файлом и полями', async () => {
    const { calls } = mockApi([
      adminMe,
      { path: '/api/templates', body: [] },
      { path: '/api/datasources', body: ds },
      { method: 'POST', path: '/api/templates/upload', status: 201, body: { ...tpl, id: 'up-id' } },
    ]);
    renderRoute('/admin/templates');
    await userEvent.click(await screen.findByRole('button', { name: 'Создать шаблон' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Название'), 'Отчёт');
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Загрузить файл' }));
    const file = new File(['PK\u0003\u0004'], 'report.xlsx');
    await userEvent.upload(within(dialog).getByLabelText('Файл шаблона'), file);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Создать' }));
    await waitFor(() => expect(calls.some((c) => c.path === '/api/templates/upload')).toBe(true));
    const form = calls.find((c) => c.path === '/api/templates/upload')!.body as FormData;
    expect(form.get('name')).toBe('Отчёт');
    expect(form.get('datasourceId')).toBe(ds[0]!.id);
    expect((form.get('file') as File).name).toBe('report.xlsx');
  });

  it('нет источников → подсказка вместо формы', async () => {
    mockApi([
      adminMe,
      { path: '/api/templates', body: [] },
      { path: '/api/datasources', body: [] },
    ]);
    renderRoute('/admin/templates');
    await userEvent.click(await screen.findByRole('button', { name: 'Создать шаблон' }));
    expect(await screen.findByText(/Сначала добавьте источник данных/)).toBeInTheDocument();
  });

  it('дублирование и удаление', async () => {
    const { calls } = mockApi([
      adminMe,
      { path: '/api/templates', body: [tpl] },
      {
        method: 'POST',
        path: '/api/templates/t1/duplicate',
        status: 201,
        body: { ...tpl, id: 't2', name: 'Счёт (копия)' },
      },
      { method: 'DELETE', path: '/api/templates/t1', status: 204 },
    ]);
    renderRoute('/admin/templates');
    await screen.findByText('Счёт');
    await userEvent.click(screen.getByRole('button', { name: 'Дублировать' }));
    await waitFor(() =>
      expect(calls.some((c) => c.path === '/api/templates/t1/duplicate')).toBe(true),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Удалить' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/История запусков сохранится/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Удалить' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
  });

  it('ошибка загрузки (сервер 400) видна в диалоге', async () => {
    mockApi([
      adminMe,
      { path: '/api/templates', body: [] },
      { path: '/api/datasources', body: ds },
      {
        method: 'POST',
        path: '/api/templates/upload',
        status: 400,
        body: { error: { code: 'BAD_REQUEST', message: 'Файл не является документом' } },
      },
    ]);
    renderRoute('/admin/templates');
    await userEvent.click(await screen.findByRole('button', { name: 'Создать шаблон' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Название'), 'Отчёт');
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Загрузить файл' }));
    await userEvent.upload(
      within(dialog).getByLabelText('Файл шаблона'),
      new File(['x'], 'a.docx'),
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Создать' }));
    expect(await within(dialog).findByText(/Файл не является документом/)).toBeInTheDocument();
  });

  it('ошибка VALIDATION по неизвестному полю показывается в диалоге', async () => {
    mockApi([
      adminMe,
      { path: '/api/templates', body: [] },
      { path: '/api/datasources', body: ds },
      {
        method: 'POST',
        path: '/api/templates',
        status: 400,
        body: {
          error: {
            code: 'VALIDATION',
            message: 'Некорректные данные',
            details: [{ path: '/datasourceId', message: 'Источник не найден' }],
          },
        },
      },
    ]);
    renderRoute('/admin/templates');
    await userEvent.click(await screen.findByRole('button', { name: 'Создать шаблон' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Название'), 'Счёт');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Создать' }));
    expect(await within(dialog).findByText(/Источник не найден/)).toBeInTheDocument();
  });

  it('смена источника сбрасывает выбранный файл', async () => {
    mockApi([
      adminMe,
      { path: '/api/templates', body: [] },
      { path: '/api/datasources', body: ds },
    ]);
    renderRoute('/admin/templates');
    await userEvent.click(await screen.findByRole('button', { name: 'Создать шаблон' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.type(within(dialog).getByLabelText('Название'), 'Отчёт');
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Загрузить файл' }));
    await userEvent.upload(
      within(dialog).getByLabelText('Файл шаблона'),
      new File(['x'], 'a.docx'),
    );
    expect(within(dialog).getByRole('button', { name: 'Создать' })).toBeEnabled();
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Пустой DOCX' }));
    await userEvent.click(within(dialog).getByRole('radio', { name: 'Загрузить файл' }));
    expect(within(dialog).getByRole('button', { name: 'Создать' })).toBeDisabled();
  });

  it('ошибка загрузки источников видна в диалоге', async () => {
    mockApi([
      adminMe,
      { path: '/api/templates', body: [] },
      {
        path: '/api/datasources',
        status: 500,
        body: { error: { code: 'INTERNAL', message: 'Сбой чтения источников' } },
      },
    ]);
    renderRoute('/admin/templates');
    await userEvent.click(await screen.findByRole('button', { name: 'Создать шаблон' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/Сбой чтения источников/)).toBeInTheDocument();
  });
});
