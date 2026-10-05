import type { ParamValue, ParamsInput, TemplateParam } from '@carbone-reports/shared';
import { DatePicker } from '@gravity-ui/date-components';
import { dateTimeParse } from '@gravity-ui/date-utils';
import { Checkbox, NumberInput, Select, Text, TextInput } from '@gravity-ui/uikit';
import { Field } from './Field';

export interface ParamFieldProps {
  param: TemplateParam;
  value: ParamValue;
  onChange: (v: ParamValue) => void;
  error?: string;
  disabled?: boolean;
  /** Подпись вместо param.label (например, «По умолчанию» в редакторе параметров). */
  label?: string;
}

export function ParamField({ param, value, onChange, error, disabled, label }: ParamFieldProps) {
  const caption = (label ?? param.label) + (param.required && !label ? ' *' : '');
  const invalid = error ? ('invalid' as const) : undefined;

  switch (param.type) {
    case 'boolean':
      return (
        <div className="cr-field">
          <Checkbox
            checked={value === true}
            onUpdate={onChange}
            disabled={disabled}
            content={caption}
            size="l"
          />
          {error && (
            <Text color="danger" variant="body-short">
              {error}
            </Text>
          )}
        </div>
      );
    case 'number':
      return (
        <Field label={caption} error={error}>
          <NumberInput
            value={typeof value === 'number' ? value : null}
            onUpdate={(v) => onChange(v ?? null)}
            allowDecimal
            disabled={disabled}
            validationState={invalid}
            controlProps={{ 'aria-label': caption }}
          />
        </Field>
      );
    case 'date':
      return (
        <Field label={caption} error={error}>
          <DatePicker
            value={
              typeof value === 'string'
                ? (dateTimeParse(value, { format: 'YYYY-MM-DD' }) ?? null)
                : null
            }
            onUpdate={(d) => onChange(d ? d.format('YYYY-MM-DD') : null)}
            format="DD.MM.YYYY"
            hasClear={!param.required}
            disabled={disabled}
            validationState={invalid}
          />
        </Field>
      );
    case 'select':
      return (
        <Field label={caption} error={error}>
          <Select
            value={typeof value === 'string' ? [value] : []}
            options={(param.options ?? []).map((o) => ({ value: o.value, content: o.label }))}
            onUpdate={([v]) => onChange(v ?? null)}
            hasClear={!param.required}
            width="max"
            disabled={disabled}
            validationState={invalid}
          />
        </Field>
      );
    case 'query': // Task 4: выбор из SQL-списка; пока текстовое поле
    default:
      return (
        <Field label={caption} error={error}>
          <TextInput
            value={typeof value === 'string' ? value : ''}
            onUpdate={(v) => onChange(v === '' ? null : v)}
            disabled={disabled}
            validationState={invalid}
            controlProps={{ 'aria-label': caption }}
          />
        </Field>
      );
  }
}

export interface ParamFormProps {
  params: TemplateParam[];
  values: ParamsInput;
  onChange: (v: ParamsInput) => void;
  errors?: Record<string, string>;
  disabled?: boolean;
}

export function ParamForm({ params, values, onChange, errors, disabled }: ParamFormProps) {
  return (
    <div className="cr-form">
      {params.map((p) => (
        <ParamField
          key={p.name}
          param={p}
          value={values[p.name] ?? null}
          error={errors?.[p.name]}
          disabled={disabled}
          onChange={(v) => onChange({ ...values, [p.name]: v })}
        />
      ))}
    </div>
  );
}
