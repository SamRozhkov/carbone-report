import type { ParamsInput, TemplateParamDto } from '@carbone-reports/shared';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { mockApi, renderWithProviders, type MockResponse, type MockRoute } from '../test/utils';
import { ParamField, ParamForm } from './ParamForm';

const params: TemplateParamDto[] = [
  {
    name: 'company',
    label: 'Компания',
    type: 'string',
    required: true,
    defaultValue: null,
    options: null,
    sql: null,
    multiple: false,
    dependsOn: [],
  },
  {
    name: 'limit',
    label: 'Лимит',
    type: 'number',
    required: false,
    defaultValue: 10,
    options: null,
    sql: null,
    multiple: false,
    dependsOn: [],
  },
  {
    name: 'withVat',
    label: 'С НДС',
    type: 'boolean',
    required: false,
    defaultValue: false,
    options: null,
    sql: null,
    multiple: false,
    dependsOn: [],
  },
  {
    name: 'status',
    label: 'Статус',
    type: 'select',
    required: false,
    defaultValue: null,
    options: [
      { value: 'new', label: 'Новый' },
      { value: 'done', label: 'Готов' },
    ],
    sql: null,
    multiple: false,
    dependsOn: [],
  },
];

function Harness({
  onChange,
  errors,
}: {
  onChange: (v: ParamsInput) => void;
  errors?: Record<string, string>;
}) {
  const [values, setValues] = useState<ParamsInput>({
    company: null,
    limit: 10,
    withVat: false,
    status: null,
  });
  return (
    <ParamForm
      templateId="t1"
      params={params}
      values={values}
      errors={errors}
      onChange={(v) => {
        setValues(v);
        onChange(v);
      }}
    />
  );
}

describe('ParamForm', () => {
  it('поля по типам, обязательные помечены *', async () => {
    renderWithProviders(<Harness onChange={() => {}} />);
    expect(await screen.findByText('Компания *')).toBeInTheDocument();
    expect(screen.getByText('Лимит')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'С НДС' })).toBeInTheDocument();
    expect(screen.getByText('Статус')).toBeInTheDocument();
  });

  it('ввод строки и флага меняет значения; пустая строка → null', async () => {
    const onChange = vi.fn();
    renderWithProviders(<Harness onChange={onChange} />);
    const input = await screen.findByRole('textbox', { name: 'Компания *' });
    await userEvent.type(input, 'ООО');
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ company: 'ООО' }));
    await userEvent.clear(input);
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ company: null }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'С НДС' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ withVat: true }));
  });

  it('ошибки показываются у полей', async () => {
    renderWithProviders(
      <Harness onChange={() => {}} errors={{ company: 'обязательный параметр' }} />,
    );
    expect(await screen.findByText('обязательный параметр')).toBeInTheDocument();
    expect(screen.getAllByText('обязательный параметр')).toHaveLength(1);
    expect(screen.getByRole('textbox', { name: 'Компания *' })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
  });
});

// ---- SQL-списки (type=query) ----

const q = (
  name: string,
  label: string,
  dependsOn: string[],
  extra: Partial<TemplateParamDto> = {},
): TemplateParamDto => ({
  name,
  label,
  type: 'query',
  required: false,
  defaultValue: null,
  options: null,
  sql: null,
  multiple: false,
  dependsOn,
  ...extra,
});

const qParams: TemplateParamDto[] = [
  q('region', 'Регион', [], { required: true }),
  q('city', 'Город', ['region']),
];

const optionsRoute = (
  byParam: Record<string, (params: ParamsInput) => MockResponse>,
): MockRoute => ({
  method: 'POST',
  path: '/api/templates/t1/params/:name/options',
  handler: ({ url, body }) => {
    const name = url.pathname.split('/').at(-2)!;
    return byParam[name]!((body as { params: ParamsInput }).params);
  },
});

const regions = () => ({
  body: {
    options: [
      { value: 1, label: 'Север' },
      { value: 2, label: 'Юг' },
    ],
  },
});
const citiesOf = (p: ParamsInput) => ({
  body: {
    options:
      p.region === 1
        ? [
            { value: 10, label: 'Мурманск' },
            { value: 11, label: 'Архангельск' },
          ]
        : [{ value: 20, label: 'Сочи' }],
  },
});

function QHarness({
  params: ps,
  initial,
  onChange,
}: {
  params: TemplateParamDto[];
  initial: ParamsInput;
  onChange: (v: ParamsInput) => void;
}) {
  const [values, setValues] = useState<ParamsInput>(initial);
  return (
    <ParamForm
      templateId="t1"
      params={ps}
      values={values}
      onChange={(v) => {
        setValues(v);
        onChange(v);
      }}
    />
  );
}

async function pick(controlName: string, optionText: string) {
  await userEvent.click(screen.getByRole('combobox', { name: controlName }));
  await userEvent.click(await screen.findByRole('option', { name: optionText }));
}

describe('ParamForm: SQL-список', () => {
  it('до выбора родителя поле неактивно и подсказывает, кого выбрать', async () => {
    mockApi([optionsRoute({ region: regions, city: citiesOf })]);
    renderWithProviders(
      <QHarness params={qParams} initial={{ region: null, city: null }} onChange={() => {}} />,
    );
    expect(await screen.findByText('сначала выберите: Регион')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Город' })).toBeDisabled();
    expect(screen.getByRole('combobox', { name: 'Регион *' })).toBeEnabled();
  });

  it('после выбора родителя варианты грузятся с его значением', async () => {
    const onChange = vi.fn();
    const { calls } = mockApi([optionsRoute({ region: regions, city: citiesOf })]);
    renderWithProviders(
      <QHarness params={qParams} initial={{ region: null, city: null }} onChange={onChange} />,
    );
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Регион *' })).toBeEnabled());
    await pick('Регион *', 'Север');
    expect(onChange).toHaveBeenLastCalledWith({ region: 1, city: null });
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Город' })).toBeEnabled());
    const cityCall = calls.find((c) => c.path.endsWith('/city/options'));
    expect(cityCall?.body).toEqual({ params: { region: 1 } });
    await pick('Город', 'Архангельск');
    expect(onChange).toHaveBeenLastCalledWith({ region: 1, city: 11 });
    expect(screen.queryByText(/сначала выберите/)).not.toBeInTheDocument();
  });

  it('смена родителя сбрасывает недоступное значение в null', async () => {
    const onChange = vi.fn();
    mockApi([optionsRoute({ region: regions, city: citiesOf })]);
    renderWithProviders(
      <QHarness params={qParams} initial={{ region: 1, city: 10 }} onChange={onChange} />,
    );
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Город' })).toBeEnabled());
    await screen.findByText('Мурманск');
    expect(onChange).not.toHaveBeenCalled();
    await pick('Регион *', 'Юг');
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith({ region: 2, city: null }));
    const calledTimes = onChange.mock.calls.length;
    await new Promise((r) => setTimeout(r, 50));
    expect(onChange.mock.calls.length).toBe(calledTimes);
  });

  it('множественный выбор отдаёт массив исходных значений', async () => {
    const onChange = vi.fn();
    mockApi([optionsRoute({ region: regions, cities: citiesOf })]);
    const ps = [qParams[0]!, q('cities', 'Города', ['region'], { multiple: true })];
    renderWithProviders(
      <QHarness params={ps} initial={{ region: 1, cities: null }} onChange={onChange} />,
    );
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Города' })).toBeEnabled());
    await userEvent.click(screen.getByRole('combobox', { name: 'Города' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Мурманск' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Архангельск' }));
    expect(onChange).toHaveBeenLastCalledWith({ region: 1, cities: [10, 11] });
  });

  it('ошибка запроса вариантов показывается у поля', async () => {
    mockApi([
      optionsRoute({
        region: () => ({
          status: 400,
          body: {
            error: { code: 'SQL_ERROR', message: 'ошибка SQL: relation "x" does not exist' },
          },
        }),
      }),
    ]);
    renderWithProviders(
      <QHarness params={[qParams[0]!]} initial={{ region: null }} onChange={() => {}} />,
    );
    const msg = await screen.findByText('ошибка SQL: relation "x" does not exist');
    expect(msg).toHaveAttribute('data-testid', 'field-error');
  });
});

describe('ParamField: значение по умолчанию SQL-списка (редактор)', () => {
  function DefaultHarness({ onChange }: { onChange: (v: unknown) => void }) {
    const [v, setV] = useState<ParamsInput[string]>(null);
    return (
      <ParamField
        param={q('invoice', 'Счёт', [])}
        label="По умолчанию"
        value={v}
        onChange={(x) => {
          setV(x);
          onChange(x);
        }}
      />
    );
  }

  it('одно значение сохраняется без пробелов по краям; одни пробелы → null', async () => {
    const onChange = vi.fn();
    renderWithProviders(<DefaultHarness onChange={onChange} />);
    const input = await screen.findByRole('textbox', { name: 'По умолчанию' });
    await userEvent.type(input, ' 42 ');
    expect(onChange).toHaveBeenLastCalledWith('42');
    await userEvent.clear(input);
    await userEvent.type(input, '   ');
    expect(onChange).toHaveBeenLastCalledWith(null);
  });
});
