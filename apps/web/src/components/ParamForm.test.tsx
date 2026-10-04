import type { ParamsInput, TemplateParam } from '@carbone-reports/shared';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../test/utils';
import { ParamForm } from './ParamForm';

const params: TemplateParam[] = [
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
    defaultValue: 10,
    options: null,
  },
  {
    name: 'withVat',
    label: 'С НДС',
    type: 'boolean',
    required: false,
    defaultValue: false,
    options: null,
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
