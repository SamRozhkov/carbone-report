import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { loadCades } from '../lib/cades';
import * as download from '../lib/download';
import { mockApi, pickOption, renderRoute, userMe } from '../test/utils';

vi.mock('../lib/cades', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/cades')>()),
  loadCades: vi.fn(),
}));

const template = {
  id: 't1',
  name: 'Счёт',
  description: '',
  fileExt: 'docx',
  defaultOutput: 'pdf',
  updatedAt: '2026-01-10T10:00:00Z',
  outputFormats: ['pdf', 'docx', 'odt'],
  signatureAllowed: false,
  signMethod: null,
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
  'в шаблоне используется html — недоступно в бесплатной версии Carbone, см. «Справка по шаблонам»';

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
      'в шаблоне используется html — недоступно в бесплатной версии Carbone, см. «Справка по шаблонам»';
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
    await pickOption(control, 'Север');
    await userEvent.click(screen.getByRole('button', { name: 'Сформировать' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/api/reports/t1/render')?.body).toEqual({
        params: { region: 7 },
      }),
    );
  });
  it('параметры из карточки ассистента: подставлены в форму, необъявленные отброшены', async () => {
    const withQuery = {
      ...template,
      params: [
        {
          name: 'company',
          label: 'Компания',
          type: 'query',
          required: true,
          defaultValue: null,
          options: null,
          sql: null,
          multiple: false,
          dependsOn: [],
        },
        template.params[1],
      ],
    };
    const { calls } = mockApi([
      userMe,
      { path: '/api/templates/t1', body: withQuery },
      {
        method: 'POST',
        path: '/api/templates/t1/params/company/options',
        body: { options: [{ value: 2, label: 'АО Лютик' }] },
      },
      { method: 'POST', path: '/api/reports/t1/render', status: 201, body: { runId: 'r1' } },
    ]);
    renderRoute('/reports/t1', { assistantParams: { company: 2, unknown: 1 } });
    const control = await screen.findByRole('combobox', { name: 'Компания *' });
    await waitFor(() => expect(control).toHaveTextContent('АО Лютик'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Сформировать' })).toBeEnabled());
    await userEvent.click(screen.getByRole('button', { name: 'Сформировать' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path === '/api/reports/t1/render')?.body).toEqual({
        params: { company: 2, limit: 5 },
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
  describe('подпись (§39.3)', () => {
    const cert = {
      subjectCn: 'Иванов Иван Иванович',
      issuer: 'Тестовый УЦ',
      serial: '1001',
      notBefore: '2026-01-01T00:00:00.000Z',
      notAfter: '2030-01-01T00:00:00.000Z',
      fingerprint: 'AB'.repeat(32),
      keyAlg: 'RSA-2048',
    };
    const signedAt = '2026-10-19T14:32:00';
    const base = [
      userMe,
      {
        path: '/api/templates/t1',
        body: { ...template, signatureAllowed: true, signMethod: 'p12' },
      },
      { method: 'POST', path: '/api/reports/t1/render', status: 201, body: { runId: 'r1' } },
    ];

    it('подпись и скачивание подписанного PDF', async () => {
      const spy = vi.spyOn(download, 'triggerDownload').mockImplementation(() => {});
      vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:run');
      const { calls } = mockApi([
        ...base,
        { path: '/api/me/certificate', body: { certificate: cert } },
        {
          method: 'POST',
          path: '/api/runs/r1/sign',
          status: 201,
          body: {
            signerCn: 'Иванов Иван Иванович',
            fingerprint: 'AB'.repeat(32),
            signedAt,
            timestamped: false,
            method: 'p12',
          },
        },
        {
          path: '/api/runs/r1/file',
          raw: 'PDF',
          headers: { 'content-disposition': `attachment; filename="x.pdf"` },
        },
      ]);
      renderRoute('/reports/t1');
      await formAndRender();
      const btn = await screen.findByRole('button', { name: 'Подписать PDF' });
      await waitFor(() => expect(btn).toBeEnabled());
      await userEvent.click(btn);
      await userEvent.type(await screen.findByLabelText('Пароль к ключу подписи'), 'pw');
      await userEvent.click(screen.getByRole('button', { name: 'Подписать' }));
      expect(
        await screen.findByText('Подписан: Иванов Иван Иванович, 19.10.2026 14:32'),
      ).toBeInTheDocument();
      // Модальное окно скрывает остальную страницу (aria-hidden), пока не размонтировано.
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(screen.queryByRole('button', { name: 'Подписать PDF' })).not.toBeInTheDocument();
      const release = holdRequests('signed=1');
      const signedBtn = await screen.findByRole('button', { name: 'Скачать подписанный PDF' });
      await userEvent.click(signedBtn);
      await waitFor(() => expect(signedBtn).toHaveClass('g-button_loading'));
      // Обычная кнопка PDF «Сохранить как» не крутится во время скачивания подписанного.
      const pdf = within(screen.getByRole('group', { name: 'Сохранить как' })).getByRole('button', {
        name: 'PDF',
      });
      expect(pdf).not.toHaveClass('g-button_loading');
      release();
      await waitFor(() => expect(spy).toHaveBeenCalled());
      expect(calls.some((c) => c.path === '/api/runs/r1/file?format=pdf&signed=1')).toBe(true);
    });

    it('«Отмена» в диалоге подписи: при повторном открытии поле пароля пустое', async () => {
      mockApi([...base, { path: '/api/me/certificate', body: { certificate: cert } }]);
      renderRoute('/reports/t1');
      await formAndRender();
      const btn = await screen.findByRole('button', { name: 'Подписать PDF' });
      await waitFor(() => expect(btn).toBeEnabled());
      await userEvent.click(btn);
      await userEvent.type(await screen.findByLabelText('Пароль к ключу подписи'), 'pw');
      await userEvent.click(screen.getByRole('button', { name: 'Отмена' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      await userEvent.click(await screen.findByRole('button', { name: 'Подписать PDF' }));
      expect(await screen.findByLabelText('Пароль к ключу подписи')).toHaveValue('');
    });

    it('ошибка загрузки сертификата — подсказки «Загрузите сертификат…» нет', async () => {
      mockApi([
        ...base,
        {
          path: '/api/me/certificate',
          status: 500,
          body: { error: { code: 'INTERNAL', message: 'сбой' } },
        },
      ]);
      renderRoute('/reports/t1');
      await formAndRender();
      expect(await screen.findByRole('button', { name: 'Подписать PDF' })).toBeDisabled();
      await waitFor(() =>
        expect(
          vi
            .mocked(globalThis.fetch)
            .mock.calls.some(([u]) => String(u).includes('/api/me/certificate')),
        ).toBe(true),
      );
      // Ответ с ошибкой обработан (retry выключен) — подсказки всё равно нет.
      await act(() => new Promise((r) => setTimeout(r, 50)));
      expect(screen.queryByText(/Загрузите сертификат на странице/)).not.toBeInTheDocument();
    });

    it('без сертификата кнопка неактивна, есть подсказка со ссылкой', async () => {
      mockApi([...base, { path: '/api/me/certificate', body: { certificate: null } }]);
      renderRoute('/reports/t1');
      await formAndRender();
      expect(await screen.findByRole('button', { name: 'Подписать PDF' })).toBeDisabled();
      expect(screen.getByText(/Загрузите сертификат на странице/)).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Моя подпись' })).toHaveAttribute(
        'href',
        '/signature',
      );
    });

    it('ГОСТ: кнопка активна без .p12, диалог КриптоПро; после подписи — PDF со штампом и .sig', async () => {
      const spy = vi.spyOn(download, 'triggerDownload').mockImplementation(() => {});
      vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:run');
      vi.mocked(loadCades).mockResolvedValue({
        versions: vi.fn(),
        listCertificates: vi.fn(async () => [
          {
            thumbprint: 'A1',
            subjectCn: 'Петров Пётр',
            issuerCn: 'Тестовый УЦ',
            validTo: new Date('2030-01-01T00:00:00Z'),
            certificateBase64: 'CERT',
            keyBits: 256 as const,
          },
        ]),
        signHash: vi.fn(async () => 'SIG'),
      });
      const { calls } = mockApi([
        userMe,
        {
          path: '/api/templates/t1',
          body: { ...template, signatureAllowed: true, signMethod: 'gost' },
        },
        { method: 'POST', path: '/api/reports/t1/render', status: 201, body: { runId: 'r1' } },
        {
          method: 'POST',
          path: '/api/runs/r1/sign/gost/prepare',
          body: { hash: 'ab'.repeat(32), hashAlg: 'streebog256', tsaUrl: null },
        },
        {
          method: 'POST',
          path: '/api/runs/r1/sign/gost/complete',
          status: 201,
          body: {
            signerCn: 'Петров Пётр',
            fingerprint: 'AB'.repeat(32),
            signedAt,
            timestamped: true,
            method: 'gost',
          },
        },
        {
          path: '/api/runs/r1/file',
          raw: 'X',
          headers: { 'content-disposition': `attachment; filename="x.pdf"` },
        },
      ]);
      renderRoute('/reports/t1');
      await formAndRender();
      const btn = await screen.findByRole('button', { name: 'Подписать PDF' });
      expect(btn).toBeEnabled();
      // Сертификат .p12 для ГОСТ не нужен и не запрашивается.
      expect(screen.queryByText(/Загрузите сертификат на странице/)).not.toBeInTheDocument();
      await userEvent.click(btn);
      await screen.findByRole('radio', { name: /Петров Пётр/ });
      await userEvent.click(screen.getByRole('button', { name: 'Подписать' }));
      expect(
        await screen.findByText('Подписан: Петров Пётр, 19.10.2026 14:32, метка времени'),
      ).toBeInTheDocument();
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(calls.some((c) => c.path === '/api/me/certificate')).toBe(false);
      expect(
        screen.getByText(
          'Подлинность сертификата проверяется сервисом проверки подписи (например, Госуслуги)',
        ),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Скачать подписанный PDF' }),
      ).not.toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Скачать PDF со штампом' }));
      await waitFor(() =>
        expect(calls.some((c) => c.path === '/api/runs/r1/file?format=pdf&signed=1')).toBe(true),
      );
      await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
      await userEvent.click(screen.getByRole('button', { name: 'Скачать подпись (.sig)' }));
      await waitFor(() =>
        expect(calls.some((c) => c.path === '/api/runs/r1/file?format=sig')).toBe(true),
      );
    });

    it('у шаблона без signatureAllowed кнопки нет', async () => {
      mockApi([
        userMe,
        { path: '/api/templates/t1', body: template },
        { method: 'POST', path: '/api/reports/t1/render', status: 201, body: { runId: 'r1' } },
      ]);
      renderRoute('/reports/t1');
      await formAndRender();
      expect(screen.queryByRole('button', { name: 'Подписать PDF' })).not.toBeInTheDocument();
    });
  });
});
