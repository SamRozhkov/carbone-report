import type { TemplateAdminDetails } from '@carbone-reports/shared';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { adminTemplate } from '../../../test/fixtures';
import { mockApi, renderWithProviders } from '../../../test/utils';
import { PdfTab } from './PdfTab';

const att = (
  id: string,
  name: string,
  placement: 'start' | 'end',
  sortOrder: number,
  pdfa = false,
) => ({
  id,
  name,
  placement,
  sortOrder,
  size: 1024,
  pages: 2,
  pdfa,
});
const t = {
  ...adminTemplate,
  pdfOptions: {
    pdfa: false,
    watermark: { text: 'КОПИЯ', opacity: 20, color: 'gray', angle: 'diagonal' },
  },
  attachments: [att('a1', 'Титул.pdf', 'start', 0), att('a2', 'Условия.pdf', 'end', 0, true)],
} as TemplateAdminDetails;

describe('PdfTab', () => {
  it('показывает настройки и приложения в порядке документа', async () => {
    mockApi([]);
    renderWithProviders(<PdfTab template={t} />);
    expect(await screen.findByRole('textbox', { name: 'Текст водяного знака' })).toHaveValue(
      'КОПИЯ',
    );
    expect(screen.getByRole('checkbox', { name: 'Водяной знак' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Нумерация страниц' })).not.toBeChecked();
    const rows = screen.getAllByTestId('pdf-attachment');
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('Титул.pdf'),
      expect.stringContaining('Условия.pdf'),
    ]);
    expect(rows[1]!.textContent).toContain('PDF/A');
  });

  it('сохранение: только включённые блоки, пустые метаданные не отправляются', async () => {
    const { calls } = mockApi([{ method: 'PUT', path: '/api/templates/t1/pdf-options', body: t }]);
    renderWithProviders(<PdfTab template={t} />);
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Нумерация страниц' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Не нумеровать первую страницу' }));
    expect(screen.getByText('Есть несохранённые изменения')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить настройки PDF' }));
    await waitFor(() => expect(calls.at(-1)?.method).toBe('PUT'));
    expect(calls.at(-1)!.body).toEqual({
      pdfa: false,
      watermark: { text: 'КОПИЯ', opacity: 20, color: 'gray', angle: 'diagonal' },
      pageNumbers: { format: 'Стр. {page} из {pages}', position: 'bottom-center', skipFirst: true },
    });
  });

  it('ошибка у поля из ответа сервера', async () => {
    mockApi([
      {
        method: 'PUT',
        path: '/api/templates/t1/pdf-options',
        status: 400,
        body: {
          error: {
            code: 'VALIDATION',
            message: 'неверные данные запроса',
            details: [
              { path: '/watermark/text', message: 'символ «😀» не поддерживается шрифтом PDF' },
            ],
          },
        },
      },
    ]);
    renderWithProviders(<PdfTab template={t} />);
    const input = await screen.findByRole('textbox', { name: 'Текст водяного знака' });
    await userEvent.type(input, ' 😀');
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить настройки PDF' }));
    expect(
      await screen.findByText('символ «😀» не поддерживается шрифтом PDF'),
    ).toBeInTheDocument();
  });

  it('загрузка приложения: FormData с файлом и местом; перемещение и удаление', async () => {
    const { calls } = mockApi([
      { method: 'POST', path: '/api/templates/t1/attachments', status: 201, body: t },
      { method: 'PATCH', path: '/api/templates/t1/attachments/a2', body: t },
      { method: 'DELETE', path: '/api/templates/t1/attachments/a1', body: t },
    ]);
    renderWithProviders(<PdfTab template={t} />);
    const file = new File(['%PDF-1.7'], 'Акт.pdf', { type: 'application/pdf' });
    await userEvent.upload(await screen.findByLabelText('Файл PDF для приложения'), file);
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    const form = calls.find((c) => c.method === 'POST')!.body as FormData;
    expect((form.get('file') as File).name).toBe('Акт.pdf');
    expect(form.get('placement')).toBe('end');

    await userEvent.click(screen.getByRole('button', { name: 'Условия.pdf: в начало' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ placement: 'start' });

    await userEvent.click(screen.getByRole('button', { name: 'Титул.pdf: удалить' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Удалить' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
    expect(calls.find((c) => c.method === 'DELETE')!.path).toBe('/api/templates/t1/attachments/a1');
  });

  it('ошибка удаления приложения: диалог закрывается, ошибка видна', async () => {
    mockApi([
      {
        method: 'DELETE',
        path: '/api/templates/t1/attachments/a1',
        status: 500,
        body: { error: { code: 'INTERNAL', message: 'сбой хранилища' } },
      },
    ]);
    renderWithProviders(<PdfTab template={t} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Титул.pdf: удалить' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Удалить' }));
    expect(await screen.findByText('сбой хранилища')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText('Удалить приложенный файл?')).not.toBeInTheDocument(),
    );
  });

  it('порядок строк — сначала начало, потом конец, независимо от порядка в массиве', async () => {
    mockApi([]);
    const shuffled = {
      ...t,
      attachments: [att('e1', 'Конец.pdf', 'end', 0), att('s1', 'Начало.pdf', 'start', 0)],
    } as TemplateAdminDetails;
    renderWithProviders(<PdfTab template={shuffled} />);
    const rows = await screen.findAllByTestId('pdf-attachment');
    expect(rows.map((r) => r.textContent)).toEqual([
      expect.stringContaining('Начало.pdf'),
      expect.stringContaining('Конец.pdf'),
    ]);
  });
});

describe('PdfTab — защита (§37.3)', () => {
  const base = { ...adminTemplate, pdfOptions: { pdfa: false } } as TemplateAdminDetails;

  it('пароль не задан: поле; ввод и запрет — отправляются password и protection', async () => {
    const { calls } = mockApi([
      {
        method: 'PUT',
        path: '/api/templates/t1/pdf-options',
        body: { ...base, pdfPasswordSet: true },
      },
    ]);
    renderWithProviders(<PdfTab template={base} />);
    await userEvent.type(await screen.findByLabelText('Пароль на открытие'), 'секрет1');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Запретить печать' }));
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить настройки PDF' }));
    await waitFor(() => expect(calls.at(-1)?.method).toBe('PUT'));
    expect(calls.at(-1)!.body).toEqual({
      pdfa: false,
      protection: { noPrint: true, noCopy: false, noModify: false },
      password: 'секрет1',
    });
  });

  it('«Показать» меняет тип поля', async () => {
    mockApi([]);
    renderWithProviders(<PdfTab template={base} />);
    const input = await screen.findByLabelText('Пароль на открытие');
    expect(input).toHaveAttribute('type', 'password');
    await userEvent.click(screen.getByRole('button', { name: 'Показать' }));
    expect(input).toHaveAttribute('type', 'text');
  });

  it('пароль задан: «Пароль задан»; «Убрать» отправляет null; без правок password не отправляется', async () => {
    const withPw = { ...base, pdfPasswordSet: true } as TemplateAdminDetails;
    // mockApi отдаёт первый подходящий маршрут: оба сохранения получают withPw.
    const { calls } = mockApi([
      { method: 'PUT', path: '/api/templates/t1/pdf-options', body: withPw },
    ]);
    renderWithProviders(<PdfTab template={withPw} />);
    expect(await screen.findByText('Пароль задан')).toBeInTheDocument();
    expect(screen.queryByLabelText('Пароль на открытие')).toBeNull();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Запретить изменение' }));
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить настройки PDF' }));
    await waitFor(() => expect(calls.at(-1)?.method).toBe('PUT'));
    expect(calls.at(-1)!.body).not.toHaveProperty('password');
    await userEvent.click(screen.getByRole('button', { name: 'Убрать' }));
    expect(screen.getByText('Пароль будет снят при сохранении')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить настройки PDF' }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls.at(-1)!.body).toMatchObject({ password: null });
  });

  it('«Сменить» показывает поле, «Отмена» возвращает «Пароль задан»', async () => {
    mockApi([]);
    renderWithProviders(
      <PdfTab template={{ ...base, pdfPasswordSet: true } as TemplateAdminDetails} />,
    );
    await userEvent.click(await screen.findByRole('button', { name: 'Сменить' }));
    expect(screen.getByLabelText('Пароль на открытие')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Отмена' }));
    expect(screen.getByText('Пароль задан')).toBeInTheDocument();
  });

  it('PDF/A выключает блок «Защита», защита выключает PDF/A', async () => {
    mockApi([]);
    renderWithProviders(<PdfTab template={base} />);
    await userEvent.click(await screen.findByRole('checkbox', { name: 'PDF/A-2b' }));
    expect(screen.getByText('Недоступно при PDF/A')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Запретить печать' })).toBeDisabled();
    expect(screen.getByLabelText('Пароль на открытие')).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', { name: 'PDF/A-2b' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Запретить копирование текста' }));
    expect(screen.getByRole('checkbox', { name: 'PDF/A-2b' })).toBeDisabled();
    expect(screen.getAllByText('Недоступно при пароле или запретах').length).toBeGreaterThan(0);
  });

  it('ошибка пароля — у поля', async () => {
    mockApi([
      {
        method: 'PUT',
        path: '/api/templates/t1/pdf-options',
        status: 400,
        body: {
          error: {
            code: 'VALIDATION',
            message: 'неверные данные запроса',
            details: [{ path: '/password', message: 'пароль — от 4 до 64 символов' }],
          },
        },
      },
    ]);
    renderWithProviders(<PdfTab template={base} />);
    await userEvent.type(await screen.findByLabelText('Пароль на открытие'), 'abc');
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить настройки PDF' }));
    expect(await screen.findByText('пароль — от 4 до 64 символов')).toBeInTheDocument();
  });
});

describe('PdfTab — электронная подпись (§39.2)', () => {
  const base = { ...adminTemplate, pdfOptions: { pdfa: false } } as TemplateAdminDetails;
  const SAVE = { method: 'PUT', path: '/api/templates/t1/pdf-options', body: base } as const;
  const pick = async (name: string) => {
    await userEvent.click(screen.getByRole('combobox', { name: 'Положение штампа' }));
    await userEvent.click(await screen.findByRole('option', { name }));
  };

  it('флажок включает положение (по умолчанию справа); сохранение и выключение', async () => {
    const { calls } = mockApi([SAVE]);
    renderWithProviders(<PdfTab template={base} />);
    expect(screen.queryByRole('combobox', { name: 'Положение штампа' })).toBeNull();
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Разрешить подпись PDF' }));
    expect(screen.getByRole('combobox', { name: 'Положение штампа' })).toHaveTextContent(
      'Внизу справа',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить настройки PDF' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toEqual({ pdfa: false, signature: { position: 'bottom-right' } });
  });

  it('выбор «Внизу слева» отправляет bottom-left', async () => {
    const { calls } = mockApi([SAVE]);
    renderWithProviders(<PdfTab template={base} />);
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Разрешить подпись PDF' }));
    await pick('Внизу слева');
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить настройки PDF' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).toEqual({ pdfa: false, signature: { position: 'bottom-left' } });
  });

  it('выключение подписи — тело без signature', async () => {
    const on = {
      ...base,
      pdfOptions: { pdfa: false, signature: { position: 'bottom-left' } },
    } as TemplateAdminDetails;
    const { calls } = mockApi([SAVE]);
    renderWithProviders(<PdfTab template={on} />);
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Разрешить подпись PDF' }));
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить настройки PDF' }));
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]!.body).not.toHaveProperty('signature');
  });

  it('пояснения видны', async () => {
    mockApi([]);
    renderWithProviders(<PdfTab template={base} />);
    expect(
      await screen.findByText(
        'Отчёт подписывает пользователь своим сертификатом после формирования.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'Штамп ставится поверх последней страницы — оставьте внизу последней страницы 110 пт.',
      ),
    ).toBeInTheDocument();
  });

  it('запрет или пароль делают подпись недоступной', async () => {
    mockApi([]);
    const { unmount } = renderWithProviders(<PdfTab template={base} />);
    await userEvent.click(
      await screen.findByRole('checkbox', { name: 'Запретить копирование текста' }),
    );
    expect(screen.getByRole('checkbox', { name: 'Разрешить подпись PDF' })).toBeDisabled();
    expect(screen.getAllByText('Недоступно при пароле или запретах')).toHaveLength(2);
    unmount();
    renderWithProviders(
      <PdfTab template={{ ...base, pdfPasswordSet: true } as TemplateAdminDetails} />,
    );
    expect(await screen.findByRole('checkbox', { name: 'Разрешить подпись PDF' })).toBeDisabled();
  });

  it('подпись блокирует защиту, PDF/A остаётся активным', async () => {
    mockApi([]);
    renderWithProviders(<PdfTab template={base} />);
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Разрешить подпись PDF' }));
    expect(screen.getByText('Недоступно при электронной подписи')).toBeInTheDocument();
    for (const n of ['Запретить печать', 'Запретить копирование текста', 'Запретить изменение']) {
      expect(screen.getByRole('checkbox', { name: n })).toBeDisabled();
    }
    expect(screen.getByLabelText('Пароль на открытие')).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'PDF/A-2b' })).toBeEnabled();
  });

  it('при заданном пароле кнопки «Сменить»/«Убрать» неактивны при подписи', async () => {
    mockApi([]);
    const withPw = {
      ...base,
      pdfPasswordSet: true,
      pdfOptions: { pdfa: false, signature: { position: 'bottom-right' } },
    } as TemplateAdminDetails;
    renderWithProviders(<PdfTab template={withPw} />);
    expect(await screen.findByRole('button', { name: 'Сменить' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Убрать' })).toBeDisabled();
  });

  it('ошибка сервера у /signature — под блоком', async () => {
    mockApi([
      {
        method: 'PUT',
        path: '/api/templates/t1/pdf-options',
        status: 400,
        body: {
          error: {
            code: 'VALIDATION',
            message: 'неверные данные запроса',
            details: [
              { path: '/signature', message: 'Подпись несовместима с паролем и ограничениями' },
            ],
          },
        },
      },
    ]);
    renderWithProviders(<PdfTab template={base} />);
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Разрешить подпись PDF' }));
    await userEvent.click(screen.getByRole('button', { name: 'Сохранить настройки PDF' }));
    expect(
      await screen.findByText('Подпись несовместима с паролем и ограничениями'),
    ).toBeInTheDocument();
  });

  it('черновик: снятый флажок не теряет выбранное положение', async () => {
    mockApi([]);
    renderWithProviders(<PdfTab template={base} />);
    const box = await screen.findByRole('checkbox', { name: 'Разрешить подпись PDF' });
    await userEvent.click(box);
    await pick('Внизу по центру');
    await userEvent.click(box);
    await userEvent.click(box);
    expect(screen.getByRole('combobox', { name: 'Положение штампа' })).toHaveTextContent(
      'Внизу по центру',
    );
  });
});
