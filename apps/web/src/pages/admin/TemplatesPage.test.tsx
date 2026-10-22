import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { changeLocale } from '../../i18n';
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
  ownerId: null,
  canDelete: true,
};

function row(name: string): HTMLElement {
  return screen.getByText(name).closest('tr')!;
}

describe('TemplatesPage', () => {
  it('создание пустого DOCX → POST JSON и переход в редактор', async () => {
    const { calls } = mockApi([
      adminMe,
      { path: '/api/templates', body: [] },
      { path: '/api/datasources/options', body: ds },
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
      { path: '/api/datasources/options', body: ds },
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
      { path: '/api/datasources/options', body: [] },
    ]);
    renderRoute('/admin/templates');
    await userEvent.click(await screen.findByRole('button', { name: 'Создать шаблон' }));
    expect(await screen.findByText(/Сначала добавьте источник данных/)).toBeInTheDocument();
  });

  it('метка «Редактирует» только при действующей блокировке', async () => {
    mockApi([
      adminMe,
      {
        path: '/api/templates',
        body: [
          { ...tpl, editingBy: { login: 'petrov' } },
          { ...tpl, id: 't2', name: 'Акт', editingBy: null },
        ],
      },
    ]);
    renderRoute('/admin/templates');
    await screen.findByText('Акт');
    expect(screen.getAllByText(/^Редактирует /)).toHaveLength(1);
    expect(screen.getByText('Редактирует petrov')).toBeInTheDocument();
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
      { path: '/api/datasources/options', body: ds },
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
      { path: '/api/datasources/options', body: ds },
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
      { path: '/api/datasources/options', body: ds },
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
        path: '/api/datasources/options',
        status: 500,
        body: { error: { code: 'INTERNAL', message: 'Сбой чтения источников' } },
      },
    ]);
    renderRoute('/admin/templates');
    await userEvent.click(await screen.findByRole('button', { name: 'Создать шаблон' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByText(/Сбой чтения источников/)).toBeInTheDocument();
  });

  it('редактор: список scope=edit, «Удалить» — только при canDelete (§43.5)', async () => {
    const { calls } = mockApi([
      { path: '/api/auth/me', body: { id: 'ed-id', login: 'editor', role: 'editor' } },
      {
        path: '/api/templates',
        body: [
          { ...tpl, editingBy: null, ownerId: 'ed-id', canDelete: true },
          { ...tpl, id: 't2', name: 'Акт', editingBy: null, ownerId: 'other', canDelete: false },
        ],
      },
    ]);
    renderRoute('/admin/templates');
    await screen.findByText('Акт');
    expect(calls.some((c) => c.method === 'GET' && c.path === '/api/templates?scope=edit')).toBe(
      true,
    );
    expect(within(row('Счёт')).getByRole('button', { name: 'Удалить' })).toBeInTheDocument();
    expect(within(row('Акт')).queryByRole('button', { name: 'Удалить' })).not.toBeInTheDocument();
    expect(within(row('Акт')).getByRole('button', { name: 'Дублировать' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Создать шаблон' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Загрузить из архива' })).toBeInTheDocument();
  });
});

describe('TemplatesPage: язык интерфейса', () => {
  const latinDs = [{ ...ds[0], name: 'Warehouse' }];

  // §44.6: моки на латинице — кириллица на странице могла бы прийти только из кода.
  it('на de список шаблонов без кириллицы', async () => {
    await changeLocale('de', { persist: 'none' });
    mockApi([
      adminMe,
      {
        path: '/api/templates',
        body: [
          {
            ...tpl,
            name: 'Invoice',
            description: 'Payment invoice',
            editingBy: { id: 'u2', login: 'petrov' },
          },
        ],
      },
    ]);
    renderRoute('/admin/templates');
    await screen.findByText('Invoice');
    expect(screen.getByRole('heading', { level: 1, name: 'Vorlagen' })).toBeInTheDocument();
    for (const name of ['Exportieren', 'Aus Archiv importieren', 'Vorlage erstellen'])
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    for (const name of ['Name', 'Typ', 'Geändert'])
      expect(screen.getByRole('columnheader', { name })).toBeInTheDocument();
    expect(within(row('Invoice')).getByText('Wird von petrov bearbeitet')).toBeInTheDocument();
    expect(within(row('Invoice')).getByRole('button', { name: 'Duplizieren' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: '„Invoice“ auswählen' }));
    expect(screen.getByRole('button', { name: 'Exportieren (1)' })).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/[Ѐ-ӿ]/);
  });

  it('на de диалог загрузки из архива с предпросмотром без кириллицы', async () => {
    await changeLocale('de', { persist: 'none' });
    mockApi([
      adminMe,
      { path: '/api/templates', body: [] },
      { path: '/api/datasources/options', body: latinDs },
      {
        method: 'POST',
        path: '/api/templates/import/preview',
        body: {
          appVersion: '2.13.0',
          exportedAt: '2026-10-10T10:00:00Z',
          templates: [
            {
              index: 0,
              name: 'Invoice',
              description: '',
              fileExt: 'docx',
              existing: [],
              datasource: {
                name: 'Sales',
                host: 'db',
                port: 5432,
                database: 'wh',
                username: 'ro',
                sslMode: 'disable',
              },
              datasourceMatch: null,
              category: 'Finance',
              categoryExists: false,
              categorySkipped: false,
              groups: ['Accounting'],
              missingGroups: ['Accounting'],
              pdfPasswordSet: true,
              errors: [],
            },
          ],
        },
      },
    ]);
    renderRoute('/admin/templates');
    await userEvent.click(await screen.findByRole('button', { name: 'Aus Archiv importieren' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Vorlagen aus Archiv importieren')).toBeInTheDocument();
    await userEvent.upload(
      within(dialog).getByLabelText('Archivdatei'),
      new File(['PK'], 'a.crt.zip'),
    );
    expect(await within(dialog).findByText('Invoice')).toBeInTheDocument();
    for (const name of ['Vorlage', 'Aktion', 'Datenquelle'])
      expect(within(dialog).getByRole('columnheader', { name })).toBeInTheDocument();
    expect(
      within(dialog).getByText('Fehlende Gruppen: Accounting — der Zugriff wird nicht gewährt'),
    ).toBeInTheDocument();
    expect(within(dialog).getByText('Die Kategorie „Finance“ wird angelegt')).toBeInTheDocument();
    expect(
      within(dialog).getByText('Im Archiv: „Sales“ (db) — in dieser Umgebung nicht gefunden'),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(/^Das PDF-Passwort wird nicht übernommen/)).toBeInTheDocument();
    expect(within(dialog).getByText(/^App-Version im Archiv: 2\.13\.0/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Importieren' })).toBeDisabled();
    expect(document.body.textContent).not.toMatch(/[Ѐ-ӿ]/);
  });
});
