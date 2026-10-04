import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import * as download from '../lib/download';
import { mockApi, renderRoute, userMe } from '../test/utils';

const template = {
  id: 't1',
  name: 'Счёт',
  description: '',
  fileExt: 'docx',
  defaultOutput: 'pdf',
  updatedAt: '2026-01-10T10:00:00Z',
  outputFormats: ['pdf', 'docx', 'odt'],
  params: [
    {
      name: 'company',
      label: 'Компания',
      type: 'string',
      required: true,
      defaultValue: null,
      options: null,
    },
    {
      name: 'limit',
      label: 'Лимит',
      type: 'number',
      required: false,
      defaultValue: 5,
      options: null,
    },
  ],
};

describe('ReportRunPage', () => {
  it('отправляет только объявленные параметры и выбранный формат; PDF — предпросмотр и ссылка', async () => {
    const { calls } = mockApi([
      userMe,
      { path: '/api/templates/t1', body: template },
      { method: 'POST', path: '/api/reports/t1/render', status: 201, body: { runId: 'r1' } },
    ]);
    renderRoute('/reports/t1');
    await userEvent.type(await screen.findByRole('textbox', { name: 'Компания *' }), 'ООО Ромашка');
    await userEvent.click(screen.getByRole('button', { name: 'Сформировать' }));

    const frame = await screen.findByTitle('Предпросмотр отчёта');
    expect(frame).toHaveAttribute('src', '/api/runs/r1/file?inline=1');
    expect(screen.getByRole('link', { name: 'Скачать' })).toHaveAttribute(
      'href',
      '/api/runs/r1/file',
    );
    const body = calls.find((c) => c.method === 'POST')?.body;
    expect(body).toEqual({ params: { company: 'ООО Ромашка', limit: 5 }, format: 'pdf' });
  });

  it('формат DOCX → скачивание сразу, без предпросмотра', async () => {
    const spy = vi.spyOn(download, 'triggerDownload').mockImplementation(() => {});
    mockApi([
      userMe,
      { path: '/api/templates/t1', body: template },
      { method: 'POST', path: '/api/reports/t1/render', status: 201, body: { runId: 'r2' } },
    ]);
    renderRoute('/reports/t1');
    await userEvent.type(await screen.findByRole('textbox', { name: 'Компания *' }), 'X');
    await userEvent.click(screen.getByRole('radio', { name: 'DOCX' }));
    await userEvent.click(screen.getByRole('button', { name: 'Сформировать' }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith('/api/runs/r2/file'));
    expect(screen.queryByTitle('Предпросмотр отчёта')).not.toBeInTheDocument();
  });

  it('ошибка параметра — у поля, прочие ошибки — общим сообщением', async () => {
    let attempt = 0;
    mockApi([
      userMe,
      { path: '/api/templates/t1', body: template },
      {
        method: 'POST',
        path: '/api/reports/t1/render',
        handler: () =>
          ++attempt === 1
            ? {
                status: 400,
                body: {
                  error: {
                    code: 'VALIDATION',
                    message: 'неверные параметры',
                    details: { fields: { company: 'обязательный параметр' } },
                  },
                },
              }
            : {
                status: 502,
                body: { error: { code: 'CARBONE_ERROR', message: 'ошибка генерации: boom' } },
              },
      },
    ]);
    renderRoute('/reports/t1');
    await userEvent.click(await screen.findByRole('button', { name: 'Сформировать' }));
    expect(await screen.findByText('обязательный параметр')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Сформировать' }));
    expect(await screen.findByText('ошибка генерации: boom')).toBeInTheDocument();
  });

  it('несуществующий шаблон → сообщение об ошибке', async () => {
    mockApi([
      userMe,
      {
        path: '/api/templates/zzz',
        status: 404,
        body: { error: { code: 'NOT_FOUND', message: 'шаблон не найден' } },
      },
    ]);
    renderRoute('/reports/zzz');
    expect(await screen.findByText('шаблон не найден')).toBeInTheDocument();
  });

  it('состояние не утекает между шаблонами', async () => {
    mockApi([
      userMe,
      { path: '/api/templates/t1', body: template },
      { path: '/api/templates/t2', body: { ...template, id: 't2', name: 'Акт' } },
      {
        method: 'POST',
        path: '/api/reports/t1/render',
        status: 502,
        body: { error: { code: 'CARBONE_ERROR', message: 'ошибка генерации: boom' } },
      },
    ]);
    const { router } = renderRoute('/reports/t1');
    await userEvent.click(await screen.findByRole('button', { name: 'Сформировать' }));
    expect(await screen.findByText('ошибка генерации: boom')).toBeInTheDocument();
    await router.navigate('/reports/t2');
    expect(await screen.findByText('Акт')).toBeInTheDocument();
    expect(screen.queryByText('ошибка генерации: boom')).not.toBeInTheDocument();
  });

  it('ошибка по незнакомому параметру видна и шаблон перезапрашивается', async () => {
    const { calls } = mockApi([
      userMe,
      { path: '/api/templates/t1', body: template },
      {
        method: 'POST',
        path: '/api/reports/t1/render',
        status: 400,
        body: {
          error: {
            code: 'VALIDATION',
            message: 'неверные параметры',
            details: { fields: { newParam: 'обязательный параметр' } },
          },
        },
      },
    ]);
    renderRoute('/reports/t1');
    await userEvent.click(await screen.findByRole('button', { name: 'Сформировать' }));
    expect(await screen.findByText(/newParam/)).toBeInTheDocument();
    await waitFor(() =>
      expect(
        calls.filter((c) => c.method === 'GET' && c.path === '/api/templates/t1').length,
      ).toBeGreaterThan(1),
    );
  });

  it('после неудачной генерации прежний предпросмотр убирается', async () => {
    let attempt = 0;
    mockApi([
      userMe,
      { path: '/api/templates/t1', body: template },
      {
        method: 'POST',
        path: '/api/reports/t1/render',
        handler: () =>
          ++attempt === 1
            ? { status: 201, body: { runId: 'r1' } }
            : {
                status: 502,
                body: { error: { code: 'CARBONE_ERROR', message: 'ошибка генерации: boom' } },
              },
      },
    ]);
    renderRoute('/reports/t1');
    await userEvent.type(await screen.findByRole('textbox', { name: 'Компания *' }), 'X');
    await userEvent.click(screen.getByRole('button', { name: 'Сформировать' }));
    await screen.findByTitle('Предпросмотр отчёта');
    await userEvent.click(screen.getByRole('button', { name: 'Сформировать' }));
    expect(await screen.findByText('ошибка генерации: boom')).toBeInTheDocument();
    expect(screen.queryByTitle('Предпросмотр отчёта')).not.toBeInTheDocument();
  });
});
