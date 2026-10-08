import { screen, waitFor, within } from '@testing-library/react';
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

const DISPOSITION = `attachment; filename="____ 2026-01-10.docx"; filename*=UTF-8''%D0%A1%D1%87%D1%91%D1%82%202026-01-10.docx`;
const COMMUNITY =
  'в шаблоне используется aggSum — недоступно в бесплатной версии Carbone, см. «Справка по шаблонам»';

/** Задерживает ответы на запросы, чей URL содержит `part`, до release(). */
function holdRequests(part: string): () => void {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const fetchMock = vi.mocked(globalThis.fetch);
  const impl = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation(async (input, init) => {
    if (String(input).includes(part)) await gate;
    return impl(input, init);
  });
  return release;
}

async function formAndRender(): Promise<HTMLElement> {
  await userEvent.type(await screen.findByRole('textbox', { name: 'Компания *' }), 'ООО Ромашка');
  await userEvent.click(screen.getByRole('button', { name: 'Сформировать' }));
  return screen.findByRole('group', { name: 'Сохранить как' });
}

describe('ReportRunPage', () => {
  it('Word-шаблон: PDF-просмотр, «Сохранить как» PDF/DOCX/ODT, основная — по defaultOutput; тело без format', async () => {
    const { calls } = mockApi([
      userMe,
      { path: '/api/templates/t1', body: template },
      { method: 'POST', path: '/api/reports/t1/render', status: 201, body: { runId: 'r1' } },
    ]);
    renderRoute('/reports/t1');
    expect(await screen.findByRole('button', { name: 'Сформировать' })).toBeInTheDocument();
    // Выбора формата на форме нет.
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.queryByText('Формат')).not.toBeInTheDocument();

    const group = await formAndRender();
    expect(screen.getByTitle('Предпросмотр отчёта')).toHaveAttribute(
      'src',
      '/api/runs/r1/file?format=pdf&inline=1',
    );
    expect(
      within(group)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['PDF', 'DOCX', 'ODT']);
    expect(within(group).getByRole('button', { name: 'PDF' })).toHaveClass('g-button_view_action');
    expect(within(group).getByRole('button', { name: 'DOCX' })).toHaveClass(
      'g-button_view_outlined',
    );
    expect(within(group).getByRole('button', { name: 'ODT' })).toHaveClass(
      'g-button_view_outlined',
    );
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      params: { company: 'ООО Ромашка', limit: 5 },
    });
  });

  it('Excel-шаблон: PDF, XLSX, ODS; основная — XLSX (defaultOutput); просмотр всё равно PDF', async () => {
    mockApi([
      userMe,
      {
        path: '/api/templates/t1',
        body: {
          ...template,
          fileExt: 'xlsx',
          defaultOutput: 'xlsx',
          outputFormats: ['pdf', 'xlsx', 'ods'],
        },
      },
      { method: 'POST', path: '/api/reports/t1/render', status: 201, body: { runId: 'r1' } },
    ]);
    renderRoute('/reports/t1');
    const group = await formAndRender();
    expect(
      within(group)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual(['PDF', 'XLSX', 'ODS']);
    expect(within(group).getByRole('button', { name: 'XLSX' })).toHaveClass('g-button_view_action');
    expect(within(group).getByRole('button', { name: 'PDF' })).toHaveClass(
      'g-button_view_outlined',
    );
    expect(screen.getByTitle('Предпросмотр отчёта')).toHaveAttribute(
      'src',
      '/api/runs/r1/file?format=pdf&inline=1',
    );
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

  it('ошибка Community показывается как есть', async () => {
    const message =
      'в шаблоне используется aggSum — недоступно в бесплатной версии Carbone, см. «Справка по шаблонам»';
    mockApi([
      userMe,
      { path: '/api/templates/t1', body: template },
      {
        method: 'POST',
        path: '/api/reports/t1/render',
        status: 400,
        body: { error: { code: 'CARBONE_COMMUNITY', message } },
      },
    ]);
    renderRoute('/reports/t1');
    await userEvent.click(await screen.findByRole('button', { name: 'Сформировать' }));
    expect(await screen.findByText(message)).toBeInTheDocument();
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

  it('«Сохранить как DOCX»: спиннер на нажатой кнопке до готовности файла, затем triggerDownload', async () => {
    const spy = vi.spyOn(download, 'triggerDownload').mockImplementation(() => {});
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:run');
    const { calls } = mockApi([
      userMe,
      { path: '/api/templates/t1', body: template },
      { method: 'POST', path: '/api/reports/t1/render', status: 201, body: { runId: 'r1' } },
      { path: '/api/runs/r1/file', raw: 'DOCX', headers: { 'content-disposition': DISPOSITION } },
    ]);
    const release = holdRequests('/file?format=docx');
    renderRoute('/reports/t1');
    const group = await formAndRender();
    const docx = within(group).getByRole('button', { name: 'DOCX' });
    await userEvent.click(docx);
    await waitFor(() => expect(docx).toHaveClass('g-button_loading'));
    expect(docx).toBeDisabled();
    // Пока идёт сборка, остальные кнопки недоступны.
    expect(within(group).getByRole('button', { name: 'PDF' })).toBeDisabled();
    expect(spy).not.toHaveBeenCalled();
    release();
    await waitFor(() => expect(spy).toHaveBeenCalledWith('blob:run', 'Счёт 2026-01-10.docx'));
    await waitFor(() => expect(docx).not.toHaveClass('g-button_loading'));
    expect(within(group).getByRole('button', { name: 'PDF' })).toBeEnabled();
    expect(calls.some((c) => c.path === '/api/runs/r1/file?format=docx')).toBe(true);
  });

  it('ошибка сборки показывается под кнопками; просмотр остаётся', async () => {
    const spy = vi.spyOn(download, 'triggerDownload').mockImplementation(() => {});
    mockApi([
      userMe,
      { path: '/api/templates/t1', body: template },
      { method: 'POST', path: '/api/reports/t1/render', status: 201, body: { runId: 'r1' } },
      {
        path: '/api/runs/r1/file',
        status: 400,
        body: { error: { code: 'CARBONE_COMMUNITY', message: COMMUNITY } },
      },
    ]);
    renderRoute('/reports/t1');
    const group = await formAndRender();
    await userEvent.click(within(group).getByRole('button', { name: 'DOCX' }));
    expect(await screen.findByText(COMMUNITY)).toBeInTheDocument();
    expect(screen.getByText('Не удалось сохранить файл')).toBeInTheDocument();
    expect(screen.getByTitle('Предпросмотр отчёта')).toBeInTheDocument();
    expect(within(group).getByRole('button', { name: 'DOCX' })).toBeEnabled();
    expect(spy).not.toHaveBeenCalled();
  });

  it('повторное «Сформировать» — новый запуск и новый просмотр; прежняя ошибка сохранения убрана', async () => {
    let n = 0;
    mockApi([
      userMe,
      { path: '/api/templates/t1', body: template },
      {
        method: 'POST',
        path: '/api/reports/t1/render',
        handler: () => ({ status: 201, body: { runId: `r${++n}` } }),
      },
      {
        path: '/api/runs/r1/file',
        status: 410,
        body: { error: { code: 'GONE', message: 'файл удалён — сформируйте отчёт заново' } },
      },
    ]);
    renderRoute('/reports/t1');
    const group = await formAndRender();
    expect(screen.getByTitle('Предпросмотр отчёта')).toHaveAttribute(
      'src',
      '/api/runs/r1/file?format=pdf&inline=1',
    );
    await userEvent.click(within(group).getByRole('button', { name: 'ODT' }));
    expect(await screen.findByText('файл удалён — сформируйте отчёт заново')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Сформировать' }));
    await waitFor(() =>
      expect(screen.getByTitle('Предпросмотр отчёта')).toHaveAttribute(
        'src',
        '/api/runs/r2/file?format=pdf&inline=1',
      ),
    );
    expect(screen.queryByText('файл удалён — сформируйте отчёт заново')).not.toBeInTheDocument();
  });

  it('SQL-список: варианты с сервера шаблона, выбранное значение уходит исходного типа', async () => {
    const withQuery = {
      ...template,
      params: [
        {
          name: 'region',
          label: 'Регион',
          type: 'query',
          required: true,
          defaultValue: null,
          options: null,
          sql: null,
          multiple: false,
          dependsOn: [],
        },
      ],
    };
    const { calls } = mockApi([
      userMe,
      { path: '/api/templates/t1', body: withQuery },
      {
        method: 'POST',
        path: '/api/templates/t1/params/region/options',
        body: { options: [{ value: 7, label: 'Север' }] },
      },
      { method: 'POST', path: '/api/reports/t1/render', status: 201, body: { runId: 'r1' } },
    ]);
    renderRoute('/reports/t1');
    const control = await screen.findByRole('combobox', { name: 'Регион *' });
    await userEvent.click(control);
    await userEvent.click(await screen.findByRole('option', { name: 'Север' }));
    await userEvent.click(screen.getByRole('button', { name: 'Сформировать' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/api/reports/t1/render')?.body).toEqual({
        params: { region: 7 },
      }),
    );
  });
  it('пока грузятся варианты SQL-параметров, «Сформировать» неактивна', async () => {
    const withQuery = {
      ...template,
      params: [
        {
          name: 'region',
          label: 'Регион',
          type: 'query',
          required: false,
          defaultValue: null,
          options: null,
          sql: null,
          multiple: false,
          dependsOn: [],
        },
      ],
    };
    mockApi([
      userMe,
      { path: '/api/templates/t1', body: withQuery },
      {
        method: 'POST',
        path: '/api/templates/t1/params/region/options',
        body: { options: [{ value: 7, label: 'Север' }] },
      },
    ]);
    // Ответ на варианты задерживается до release().
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchMock = vi.mocked(globalThis.fetch);
    const impl = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input).includes('/options')) await gate;
      return impl(input, init);
    });
    renderRoute('/reports/t1');
    const button = await screen.findByRole('button', { name: 'Сформировать' });
    await waitFor(() => expect(button).toBeDisabled());
    expect(screen.getByText('Загружаются варианты параметров…')).toBeInTheDocument();
    release();
    await waitFor(() => expect(button).toBeEnabled());
    expect(screen.queryByText('Загружаются варианты параметров…')).not.toBeInTheDocument();
  });
});
