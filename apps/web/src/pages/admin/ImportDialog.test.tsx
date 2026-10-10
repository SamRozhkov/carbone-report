import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { adminMe, mockApi, renderRoute } from '../../test/utils';

const DS1 = '11111111-1111-4111-8111-111111111111';
const DS2 = '22222222-2222-4222-8222-222222222222';
const ds = [DS1, DS2].map((id, i) => ({
  id,
  name: i === 0 ? 'Склад' : 'Продажи',
  host: 'db',
  port: 5432,
  database: 'wh',
  username: 'ro',
  sslMode: 'disable',
  sslCa: null,
  createdAt: '2026-01-01T00:00:00Z',
}));
const T1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const T2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const item = (over: Record<string, unknown>) => ({
  index: 0,
  name: 'Счёт',
  description: '',
  fileExt: 'docx',
  existing: [],
  datasource: {
    name: 'Склад',
    host: 'db',
    port: 5432,
    database: 'wh',
    username: 'ro',
    sslMode: 'disable',
  },
  datasourceMatch: DS1,
  category: null,
  categoryExists: true,
  groups: [],
  missingGroups: [],
  errors: [],
  ...over,
});
const preview = (templates: unknown[]) => ({
  appVersion: '2.3.0',
  exportedAt: '2026-10-10T10:00:00Z',
  templates,
});

const base = [
  adminMe,
  { path: '/api/templates', body: [] },
  { path: '/api/datasources', body: ds },
];

async function openDialog(file = new File(['PK'], 'a.crt.zip')) {
  renderRoute('/admin/templates');
  await userEvent.click(await screen.findByRole('button', { name: 'Загрузить из архива' }));
  const dialog = await screen.findByRole('dialog');
  await userEvent.upload(within(dialog).getByLabelText('Файл архива'), file);
  return dialog;
}

describe('ImportDialog', () => {
  it('нет совпадения → «создать», источник подставлен по имени; загрузка и итог', async () => {
    const { calls } = mockApi([
      ...base,
      {
        method: 'POST',
        path: '/api/templates/import/preview',
        body: preview([
          item({ missingGroups: ['Бухгалтерия'], category: 'Счета', categoryExists: false }),
        ]),
      },
      {
        method: 'POST',
        path: '/api/templates/import',
        body: { templates: [{ index: 0, action: 'create', name: 'Счёт', id: T1 }] },
      },
    ]);
    const dialog = await openDialog();
    expect(await within(dialog).findByText('Счёт')).toBeInTheDocument();
    expect(within(dialog).getByText(/Нет групп: Бухгалтерия/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Будет создана категория «Счета»/)).toBeInTheDocument();
    const apply = within(dialog).getByRole('button', { name: 'Загрузить' });
    await waitFor(() => expect(apply).toBeEnabled());
    expect(
      (calls.find((c) => c.path.endsWith('/preview'))!.body as FormData).get('file'),
    ).toBeTruthy();
    await userEvent.click(apply);
    expect(await within(dialog).findByText('создан')).toBeInTheDocument();
    const form = calls.find((c) => c.path === '/api/templates/import')!.body as FormData;
    expect(JSON.parse(form.get('decisions') as string)).toEqual([
      { index: 0, action: 'create', datasourceId: DS1 },
    ]);
  });

  it('источника нет по имени → «Загрузить» неактивна, пока не выбран (Review Focus 5)', async () => {
    mockApi([
      ...base,
      {
        method: 'POST',
        path: '/api/templates/import/preview',
        body: preview([item({ datasourceMatch: null })]),
      },
    ]);
    const dialog = await openDialog();
    await within(dialog).findByText('Счёт');
    const apply = within(dialog).getByRole('button', { name: 'Загрузить' });
    expect(apply).toBeDisabled();
    await userEvent.click(within(dialog).getByRole('combobox', { name: /Источник данных: Счёт/ }));
    await userEvent.click(await screen.findByRole('option', { name: 'Продажи' }));
    await waitFor(() => expect(apply).toBeEnabled());
  });

  it('совпадение → «обновить» с самым свежим; несколько — выбор цели; targetId в решении', async () => {
    const { calls } = mockApi([
      ...base,
      {
        method: 'POST',
        path: '/api/templates/import/preview',
        body: preview([
          item({
            existing: [
              { id: T1, name: 'Счёт', updatedAt: '2026-10-09T10:00:00Z' },
              { id: T2, name: 'Счёт', updatedAt: '2026-10-01T10:00:00Z' },
            ],
          }),
        ]),
      },
      {
        method: 'POST',
        path: '/api/templates/import',
        body: { templates: [{ index: 0, action: 'update', name: 'Счёт', id: T2 }] },
      },
    ]);
    const dialog = await openDialog();
    await within(dialog).findByText('Счёт');
    expect(within(dialog).getByRole('combobox', { name: /Действие: Счёт/ })).toHaveTextContent(
      'обновить',
    );
    await userEvent.click(within(dialog).getByRole('combobox', { name: /Какой шаблон обновить/ }));
    const options = await screen.findAllByRole('option');
    await userEvent.click(options[1]!);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Загрузить' }));
    await within(dialog).findByText('обновлён');
    const form = calls.find((c) => c.path === '/api/templates/import')!.body as FormData;
    expect(JSON.parse(form.get('decisions') as string)).toEqual([
      {
        index: 0,
        action: 'update',
        datasourceId: DS1,
        targetId: T2,
        targetUpdatedAt: '2026-10-01T10:00:00Z',
      },
    ]);
  });

  it('шаблон с ошибками можно только пропустить; все «пропустить» → загрузка недоступна', async () => {
    mockApi([
      ...base,
      {
        method: 'POST',
        path: '/api/templates/import/preview',
        body: preview([item({ errors: ['параметр «a»: неверное значение'] })]),
      },
    ]);
    const dialog = await openDialog();
    expect(await within(dialog).findByText(/параметр «a»: неверное значение/)).toBeInTheDocument();
    expect(within(dialog).getByRole('combobox', { name: /Действие: Счёт/ })).toHaveTextContent(
      'пропустить',
    );
    expect(within(dialog).getByRole('button', { name: 'Загрузить' })).toBeDisabled();
  });

  it('IMPORT_INVALID при предпросмотре → текст из ответа', async () => {
    mockApi([
      ...base,
      {
        method: 'POST',
        path: '/api/templates/import/preview',
        status: 400,
        body: { error: { code: 'IMPORT_INVALID', message: 'контрольная сумма не совпала' } },
      },
    ]);
    const dialog = await openDialog();
    expect(await within(dialog).findByText('контрольная сумма не совпала')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Загрузить' })).toBeDisabled();
  });

  it('409 при загрузке → текст сервера и «Повторить предпросмотр»', async () => {
    const { calls } = mockApi([
      ...base,
      {
        method: 'POST',
        path: '/api/templates/import/preview',
        body: preview([item({})]),
      },
      {
        method: 'POST',
        path: '/api/templates/import',
        status: 409,
        body: {
          error: { code: 'CONFLICT', message: 'шаблон «Счёт» изменился после предпросмотра' },
        },
      },
    ]);
    const dialog = await openDialog();
    await within(dialog).findByText('Счёт');
    const apply = within(dialog).getByRole('button', { name: 'Загрузить' });
    await waitFor(() => expect(apply).toBeEnabled());
    await userEvent.click(apply);
    expect(await within(dialog).findByText(/изменился после предпросмотра/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Повторить предпросмотр' }));
    await waitFor(() => expect(calls.filter((c) => c.path.endsWith('/preview'))).toHaveLength(2));
  });

  it('409 → повторный предпросмотр сохраняет выбор по строкам; недопустимый — сброс с пометкой', async () => {
    const A = item({
      index: 0,
      name: 'Акт',
      existing: [
        { id: T1, name: 'Акт', updatedAt: '2026-10-09T10:00:00.000001Z' },
        { id: T2, name: 'Акт', updatedAt: '2026-10-01T10:00:00.000001Z' },
      ],
    });
    const B = item({
      index: 1,
      name: 'Счёт',
      existing: [{ id: T1, name: 'Счёт', updatedAt: '2026-10-09T10:00:00.000001Z' }],
    });
    const C = item({ index: 2, name: 'Накладная', datasourceMatch: null });
    let previews = 0;
    const { calls } = mockApi([
      ...base,
      {
        method: 'POST',
        path: '/api/templates/import/preview',
        handler: () => {
          previews++;
          if (previews === 1) return { body: preview([A, B, C]) };
          // Во второй раз: у «Акта» старая цель изменена, у «Счёта» совпадения больше нет.
          return {
            body: preview([
              {
                ...A,
                existing: [
                  A.existing[0],
                  { id: T2, name: 'Акт', updatedAt: '2026-10-10T12:00:00.000001Z' },
                ],
              },
              { ...B, existing: [] },
              C,
            ]),
          };
        },
      },
      {
        method: 'POST',
        path: '/api/templates/import',
        handler: () =>
          calls.filter((c) => c.path === '/api/templates/import').length === 1
            ? { status: 409, body: { error: { code: 'CONFLICT', message: 'данные изменились' } } }
            : { body: { templates: [] } },
      },
    ]);
    const dialog = await openDialog();
    await within(dialog).findByText('Акт');
    // «Акт»: обновить старый T2; «Счёт»: копия; «Накладная»: выбран источник «Продажи».
    await userEvent.click(
      within(dialog).getByRole('combobox', { name: /Какой шаблон обновить: Акт/ }),
    );
    await userEvent.click((await screen.findAllByRole('option'))[1]!);
    await userEvent.click(within(dialog).getByRole('combobox', { name: /Действие: Счёт/ }));
    await userEvent.click(await screen.findByRole('option', { name: 'копия' }));
    await userEvent.click(
      within(dialog).getByRole('combobox', { name: /Источник данных: Накладная/ }),
    );
    await userEvent.click(await screen.findByRole('option', { name: 'Продажи' }));
    const apply = within(dialog).getByRole('button', { name: 'Загрузить' });
    await waitFor(() => expect(apply).toBeEnabled());
    await userEvent.click(apply);
    await userEvent.click(
      await within(dialog).findByRole('button', { name: 'Повторить предпросмотр' }),
    );
    await waitFor(() => expect(previews).toBe(2));
    // «Акт»: цель сохранена, но строка помечена — шаблон изменён.
    expect(
      await within(dialog).findByText(/Шаблон изменён после прошлого предпросмотра/),
    ).toBeInTheDocument();
    expect(within(dialog).getByRole('combobox', { name: /Действие: Акт/ })).toHaveTextContent(
      'обновить',
    );
    // «Счёт»: «копия» больше недоступна — «создать» и пометка.
    expect(within(dialog).getByRole('combobox', { name: /Действие: Счёт/ })).toHaveTextContent(
      'создать',
    );
    expect(within(dialog).getByText(/«копия» больше недоступно/)).toBeInTheDocument();
    // «Накладная»: выбранный источник сохранён.
    expect(
      within(dialog).getByRole('combobox', { name: /Источник данных: Накладная/ }),
    ).toHaveTextContent('Продажи');
    await userEvent.click(apply);
    await waitFor(() =>
      expect(calls.filter((c) => c.path === '/api/templates/import')).toHaveLength(2),
    );
    const form = calls.filter((c) => c.path === '/api/templates/import')[1]!.body as FormData;
    expect(JSON.parse(form.get('decisions') as string)).toEqual([
      {
        index: 0,
        action: 'update',
        datasourceId: DS1,
        targetId: T2,
        targetUpdatedAt: '2026-10-10T12:00:00.000001Z',
      },
      { index: 1, action: 'create', datasourceId: DS1 },
      { index: 2, action: 'create', datasourceId: DS2 },
    ]);
  });

  it('файл больше 50 МБ → сообщение без запроса', async () => {
    const { calls } = mockApi(base);
    const big = new File(['x'], 'big.crt.zip');
    Object.defineProperty(big, 'size', { value: 51 * 1024 * 1024 });
    const dialog = await openDialog(big);
    expect(await within(dialog).findByText(/Архив больше 50 МБ/)).toBeInTheDocument();
    expect(calls.some((c) => c.path.includes('/import'))).toBe(false);
  });

  it('413 от nginx → понятное сообщение', async () => {
    mockApi([
      ...base,
      {
        method: 'POST',
        path: '/api/templates/import/preview',
        status: 413,
        body: { error: { code: 'PAYLOAD_TOO_LARGE', message: 'слишком большой запрос' } },
      },
    ]);
    const dialog = await openDialog();
    expect(await within(dialog).findByText(/Архив больше 50 МБ/)).toBeInTheDocument();
  });
});

describe('Выгрузка шаблонов', () => {
  const list = [
    { id: T1, name: 'Счёт', description: '', fileExt: 'docx', updatedAt: '2026-01-10T10:00:00Z' },
    { id: T2, name: 'Акт', description: '', fileExt: 'docx', updatedAt: '2026-01-10T10:00:00Z' },
  ];

  it('флажки → POST export с ids и скачивание файла', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const { calls } = mockApi([
      adminMe,
      { path: '/api/templates', body: list },
      {
        method: 'POST',
        path: '/api/templates/export',
        raw: 'PK',
        headers: {
          'content-disposition': "attachment; filename*=UTF-8''%D0%A1%D1%87%D1%91%D1%82.crt.zip",
        },
      },
    ]);
    renderRoute('/admin/templates');
    const btn = await screen.findByRole('button', { name: 'Выгрузить' });
    expect(btn).toBeDisabled();
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Выбрать «Акт»' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Выгрузить (1)' }));
    await waitFor(() => expect(click).toHaveBeenCalled());
    expect(calls.find((c) => c.path === '/api/templates/export')!.body).toEqual({ ids: [T2] });
  });

  it('больше 200 шаблонов — предупреждение без запроса', async () => {
    const many = Array.from({ length: 201 }, (_, i) => ({
      ...list[0]!,
      id: `${String(i).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
      name: `Шаблон ${i}`,
    }));
    const { calls } = mockApi([adminMe, { path: '/api/templates', body: many }]);
    renderRoute('/admin/templates');
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Выбрать все шаблоны' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Выгрузить (201)' }));
    expect(await screen.findByText(/не больше 200 шаблонов, выбрано 201/)).toBeInTheDocument();
    expect(calls.some((c) => c.path === '/api/templates/export')).toBe(false);
  });

  it('ошибка 400 → текст сервера в уведомлении', async () => {
    mockApi([
      adminMe,
      { path: '/api/templates', body: list },
      {
        method: 'POST',
        path: '/api/templates/export',
        status: 400,
        body: { error: { code: 'BAD_REQUEST', message: 'у шаблонов одинаковые названия' } },
      },
    ]);
    renderRoute('/admin/templates');
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Выбрать все шаблоны' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Выгрузить (2)' }));
    expect(await screen.findByText('у шаблонов одинаковые названия')).toBeInTheDocument();
  });
});
