import type {
  ParamValue,
  ParamsInput,
  SelectOptionValue,
  TemplateParam,
  TemplateParamDto,
} from '@carbone-reports/shared';
import { DatePicker } from '@gravity-ui/date-components';
import { dateTimeParse } from '@gravity-ui/date-utils';
import { Checkbox, NumberInput, Select, Text, TextInput } from '@gravity-ui/uikit';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api/endpoints';
import { errorMessage } from '../api/errors';
import { isEmptyParam } from '../lib/params';
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
    case 'query':
      // Значение по умолчанию в редакторе: варианты зависят от родителей, поэтому — ввод текстом.
      // Текст хранится как набран (и для множественного — строкой); обрезка и разбор по запятым —
      // при сохранении (toParam в ParamsTab), иначе запятые и пробелы пропадали бы при наборе.
      return (
        <Field
          label={caption}
          error={error}
          hint={param.multiple ? 'несколько значений — через запятую' : undefined}
        >
          <TextInput
            value={
              Array.isArray(value)
                ? value.join(', ')
                : typeof value === 'string' || typeof value === 'number'
                  ? String(value)
                  : ''
            }
            onUpdate={(v) => onChange(v.trim() === '' ? null : v)}
            disabled={disabled}
            validationState={invalid}
            controlProps={{ 'aria-label': caption }}
          />
        </Field>
      );
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

type Scalar = SelectOptionValue['value'];

/** Значение без вариантов, которых больше нет в списке; null, если ничего не осталось. */
function keepAllowed(value: ParamValue, allowed: Set<string>, multiple: boolean): ParamValue {
  if (isEmptyParam(value)) return value;
  const items = (Array.isArray(value) ? value : [value]).filter(
    (v): v is Scalar => (typeof v === 'string' || typeof v === 'number') && allowed.has(String(v)),
  );
  if (multiple) return items.length > 0 ? items : null;
  return items[0] ?? null;
}

function sameValue(a: ParamValue, b: ParamValue): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Задержка запроса вариантов после ввода в текстовый/числовой родитель. */
const OPTIONS_DEBOUNCE_MS = 400;

/**
 * Значение, отстающее от входного на delay мс после последнего изменения.
 * Сравнивается по JSON: новый объект с тем же содержимым не перезапускает таймер.
 */
function useDebouncedValue<T>(value: T, delay: number): T {
  const key = JSON.stringify(value);
  const [debounced, setDebounced] = useState(key);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(key), delay);
    return () => clearTimeout(t);
  }, [key, delay]);
  return JSON.parse(debounced) as T;
}

interface QueryParamFieldProps {
  templateId: string;
  param: TemplateParamDto;
  /** Все параметры формы — для подписей и обязательности родителей. */
  params: TemplateParamDto[];
  values: ParamsInput;
  onChange: (v: ParamValue) => void;
  /** Грузятся ли варианты (включая ожидание debounce). Вызывается при изменении. */
  onLoadingChange: (loading: boolean) => void;
  error?: string;
  disabled?: boolean;
}

/** SQL-список: варианты с сервера, зависят от значений родителей (param.dependsOn). */
function QueryParamField({
  templateId,
  param,
  params,
  values,
  onChange,
  onLoadingChange,
  error,
  disabled,
}: QueryParamFieldProps) {
  const caption = param.label + (param.required ? ' *' : '');
  const value = values[param.name] ?? null;
  const parentParams = Object.fromEntries(param.dependsOn.map((n) => [n, values[n] ?? null]));
  // Сервер ждёт только обязательных родителей (waitingFor); необязательный пустой уходит как null.
  const missing = param.dependsOn.filter(
    (n) => params.find((p) => p.name === n)?.required !== false && isEmptyParam(values[n] ?? null),
  );
  const parentsReady = missing.length === 0;

  // Текст и числа набираются посимвольно: запрос — после паузы в вводе, а не на каждый символ.
  const debounce = param.dependsOn.some((n) => {
    const type = params.find((p) => p.name === n)?.type;
    return type === 'string' || type === 'number';
  });
  const debouncedParams = useDebouncedValue(parentParams, debounce ? OPTIONS_DEBOUNCE_MS : 0);
  const queryParams = debounce ? debouncedParams : parentParams;
  // Пока ключ запроса отстаёт от родителей, варианты устарели: считаем, что они грузятся.
  const pendingDebounce = JSON.stringify(queryParams) !== JSON.stringify(parentParams);

  const options = useQuery({
    queryKey: ['param-options', templateId, param.name, queryParams],
    queryFn: () => api.templates.paramOptions(templateId, param.name, queryParams),
    enabled: parentsReady && !pendingDebounce,
  });
  const data = parentsReady ? options.data : undefined;
  const waiting = parentsReady ? (data?.waitingFor ?? []) : missing;
  const loading = parentsReady && (options.isFetching || pendingDebounce);

  const onLoadingRef = useRef(onLoadingChange);
  onLoadingRef.current = onLoadingChange;
  useEffect(() => {
    onLoadingRef.current(loading);
  }, [loading]);
  useEffect(() => () => onLoadingRef.current(false), []);

  // Варианты сменились — убираем значения, которых в них больше нет. onChange только при изменении.
  // Пока ждём debounce, варианты относятся к прежним родителям — ничего не сбрасываем.
  const allowedKey = !parentsReady
    ? '[]'
    : data && !pendingDebounce
      ? JSON.stringify(data.options.map((o) => String(o.value)))
      : null;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const valueKey = JSON.stringify(value);
  useEffect(() => {
    if (allowedKey === null) return;
    const current = JSON.parse(valueKey) as ParamValue;
    const next = keepAllowed(current, new Set(JSON.parse(allowedKey) as string[]), param.multiple);
    if (!sameValue(next, current)) onChangeRef.current(next);
  }, [allowedKey, valueKey, param.multiple]);

  const byString = new Map<string, Scalar>(
    (data?.options ?? []).map((o) => [String(o.value), o.value]),
  );
  const toValue = (s: string): Scalar => byString.get(s) ?? s;
  const selected = isEmptyParam(value)
    ? []
    : (Array.isArray(value) ? value : [value]).map((v) => String(v));
  const label = (n: string) => params.find((p) => p.name === n)?.label ?? n;
  const hint =
    waiting.length > 0 ? `сначала выберите: ${waiting.map(label).join(', ')}` : undefined;
  const shownError = error ?? (options.error ? errorMessage(options.error) : undefined);

  return (
    <Field label={caption} error={shownError} hint={hint}>
      <Select
        aria-label={caption}
        value={selected}
        options={(data?.options ?? []).map((o) => ({ value: String(o.value), content: o.label }))}
        onUpdate={(vs) => {
          if (param.multiple) onChange(vs.length > 0 ? vs.map(toValue) : null);
          else onChange(vs[0] !== undefined ? toValue(vs[0]) : null);
        }}
        multiple={param.multiple}
        filterable
        hasClear={!param.required}
        loading={loading}
        disabled={!parentsReady || disabled}
        width="max"
        validationState={shownError ? 'invalid' : undefined}
      />
    </Field>
  );
}

export interface ParamFormProps {
  templateId: string;
  params: TemplateParamDto[];
  values: ParamsInput;
  onChange: (v: ParamsInput) => void;
  errors?: Record<string, string>;
  disabled?: boolean;
  /** Грузятся ли варианты хотя бы одного SQL-параметра. Вызывается при изменении. */
  onOptionsLoadingChange?: (loading: boolean) => void;
}

export function ParamForm({
  templateId,
  params,
  values,
  onChange,
  errors,
  disabled,
  onOptionsLoadingChange,
}: ParamFormProps) {
  // Несколько полей могут сбросить значения в одном коммите: копим изменения поверх последних.
  const latest = useRef(values);
  latest.current = values;
  const set = (name: string, v: ParamValue) => {
    latest.current = { ...latest.current, [name]: v };
    onChange(latest.current);
  };
  // Поля сообщают о своей загрузке; наверх уходит только смена общего флага.
  const loadingFields = useRef(new Set<string>());
  const anyLoading = useRef(false);
  const onLoadingRef = useRef(onOptionsLoadingChange);
  onLoadingRef.current = onOptionsLoadingChange;
  const setFieldLoading = (name: string, loading: boolean) => {
    if (loading) loadingFields.current.add(name);
    else loadingFields.current.delete(name);
    const next = loadingFields.current.size > 0;
    if (next === anyLoading.current) return;
    anyLoading.current = next;
    onLoadingRef.current?.(next);
  };
  return (
    <div className="cr-form">
      {params.map((p) =>
        p.type === 'query' ? (
          <QueryParamField
            key={p.name}
            templateId={templateId}
            param={p}
            params={params}
            values={values}
            error={errors?.[p.name]}
            disabled={disabled}
            onChange={(v) => set(p.name, v)}
            onLoadingChange={(l) => setFieldLoading(p.name, l)}
          />
        ) : (
          <ParamField
            key={p.name}
            param={p}
            value={values[p.name] ?? null}
            error={errors?.[p.name]}
            disabled={disabled}
            onChange={(v) => set(p.name, v)}
          />
        ),
      )}
    </div>
  );
}
