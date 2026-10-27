// Инструменты ассистента (§50.4). Вызовы идут через существующие эндпоинты от имени
// пользователя (app.inject с его cookie): права и проверки — те же, что в интерфейсе.
// Результаты сокращаются до метаданных (§50.1): SQL, запросы и данные в модель не уходят.
import {
  type ParamOptionsResult,
  ParamsInput,
  type ParamValue,
  type RunCard,
  type RunCardItem,
  type TemplateDetails,
  type TemplateSummary,
} from '@carbone-reports/shared';
import type { Locale } from '@carbone-reports/shared/i18n';
import { z } from 'zod';
import type { AppDeps } from '../../deps';
import { AppError, translateMsg } from '../../lib/errors';
import { optionsForParam, validateQueryParams } from '../queries/param-options';
import { resolveParams } from '../queries/params';
import { loadTemplateFull } from '../templates/service';
import type { ToolSpec } from './llm';

export type ToolOutcome = { result: unknown } | { card: RunCard };
export interface AgentTools {
  specs: ToolSpec[];
  run(name: string, args: unknown): Promise<ToolOutcome>;
}
export type Inject = (
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
) => Promise<{ status: number; body: unknown }>;
export interface ToolContext {
  inject: Inject;
  deps: AppDeps;
  locale: Locale;
}

const MAX_REPORTS = 50;
const MAX_VALUES = 30;

const has = (text: string | null | undefined, q: string) =>
  (text ?? '').toLocaleLowerCase().includes(q);

export const shapeReports = (list: TemplateSummary[], search?: string) => {
  const q = search?.trim().toLocaleLowerCase();
  const found = q
    ? list.filter((t) => has(t.name, q) || has(t.description, q) || has(t.category?.name, q))
    : list;
  return {
    total: found.length,
    reports: found.slice(0, MAX_REPORTS).map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      category: t.category?.name ?? null,
    })),
  };
};

export interface ShapedParam {
  name: string;
  label: string;
  type: string;
  required: boolean;
  default: ParamValue;
  multiple: boolean;
  options?: { value: string; label: string }[];
  valuesVia?: 'find_param_values';
  dependsOn?: string[];
}

/** Только перечисленные поля: автору эндпоинт отдаёт карточку конструктора с SQL. */
export const shapeForm = (d: TemplateDetails) => ({
  id: d.id,
  name: d.name,
  description: d.description,
  params: d.params.map((p): ShapedParam => ({
    name: p.name,
    label: p.label,
    type: p.type,
    required: p.required,
    default: p.defaultValue,
    multiple: p.multiple,
    ...(p.type === 'select' && p.options
      ? { options: p.options.map((o) => ({ value: o.value, label: o.label })) }
      : {}),
    ...(p.type === 'query'
      ? { valuesVia: 'find_param_values' as const, dependsOn: p.dependsOn }
      : {}),
  })),
});

export const shapeOptions = (r: ParamOptionsResult, search?: string) => {
  if (r.waitingFor?.length) return { waitingFor: r.waitingFor };
  const q = search?.trim().toLocaleLowerCase();
  const found = q ? r.options.filter((o) => has(o.label, q) || has(String(o.value), q)) : r.options;
  return {
    total: found.length,
    values: found.slice(0, MAX_VALUES).map((o) => ({ value: o.value, label: o.label })),
  };
};

const SPECS: ToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'list_reports',
      description:
        'List report templates available to the user. Optional search filters by name, description or category (case-insensitive substring).',
      parameters: {
        type: 'object',
        properties: { search: { type: 'string' } },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_report_form',
      description:
        'Get the parameters of a report template: names, labels, types, required flags, defaults and select options.',
      parameters: {
        type: 'object',
        properties: { reportId: { type: 'string' } },
        required: ['reportId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'find_param_values',
      description:
        'Find allowed values of a parameter of type "query". search filters by label. params: values of already chosen parameters (needed for dependent lists). Use the value, not the label, in propose_run.',
      parameters: {
        type: 'object',
        properties: {
          reportId: { type: 'string' },
          param: { type: 'string' },
          search: { type: 'string' },
          params: { type: 'object' },
        },
        required: ['reportId', 'param'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_run',
      description:
        'Propose running the report with the given parameter values. The user confirms the run with a button. Returns an error if parameters are invalid.',
      parameters: {
        type: 'object',
        properties: { reportId: { type: 'string' }, params: { type: 'object' } },
        required: ['reportId', 'params'],
      },
    },
  },
];

const Id = z.string().min(1).max(100);
const Params = z.record(z.string(), z.unknown()).default({});
const ARGS = {
  list_reports: z.object({ search: z.string().max(200).optional() }),
  get_report_form: z.object({ reportId: Id }),
  find_param_values: z.object({
    reportId: Id,
    param: z.string().min(1).max(100),
    search: z.string().max(200).optional(),
    params: Params,
  }),
  propose_run: z.object({ reportId: Id, params: Params }),
};

/** Ответ эндпоинта с ошибкой → текст ошибки для модели. */
const errorOf = (r: { status: number; body: unknown }) => ({
  error: (r.body as { error?: { message?: string } } | null)?.error?.message ?? `HTTP ${r.status}`,
});

const enc = encodeURIComponent;

export function createAssistantTools(ctx: ToolContext): AgentTools {
  const { inject, deps, locale } = ctx;

  async function form(reportId: string) {
    const r = await inject('GET', `/api/templates/${enc(reportId)}`);
    return r.status === 200 ? { details: r.body as TemplateDetails } : { error: errorOf(r) };
  }

  async function display(
    reportId: string,
    resolved: Record<string, ParamValue>,
  ): Promise<RunCardItem[]> {
    const full = await loadTemplateFull(deps.db, reportId);
    const yes = translateMsg(locale, { key: 'assistant.yes' });
    const no = translateMsg(locale, { key: 'assistant.no' });
    const empty = translateMsg(locale, { key: 'assistant.empty' });
    const items: RunCardItem[] = [];
    for (const p of full.params) {
      const v = resolved[p.name];
      const values = v === null || v === undefined ? [] : Array.isArray(v) ? v : [v];
      let labels: string[];
      if (p.type === 'boolean') labels = [v ? yes : no];
      else if (p.type === 'select')
        labels = values.map(
          (x) => p.options?.find((o) => o.value === String(x))?.label ?? String(x),
        );
      else if (p.type === 'query' && values.length > 0) {
        const opts = await optionsForParam(deps, full, p.name, resolved);
        labels = values.map(
          (x) => opts.options.find((o) => String(o.value) === String(x))?.label ?? String(x),
        );
      } else labels = values.map(String);
      items.push({ label: p.label, value: labels.length ? labels.join(', ') : empty });
    }
    return items;
  }

  async function run(name: string, raw: unknown): Promise<ToolOutcome> {
    if (!(name in ARGS)) return { result: { error: `unknown tool: ${name}` } };
    const parsed = ARGS[name as keyof typeof ARGS].safeParse(raw ?? {});
    if (!parsed.success) return { result: { error: `invalid arguments: ${parsed.error.message}` } };
    const a = parsed.data as Record<string, unknown>;
    switch (name) {
      case 'list_reports': {
        const r = await inject('GET', '/api/templates');
        if (r.status !== 200) return { result: errorOf(r) };
        return {
          result: shapeReports(r.body as TemplateSummary[], a.search as string | undefined),
        };
      }
      case 'get_report_form': {
        const f = await form(a.reportId as string);
        return { result: 'error' in f ? f.error : shapeForm(f.details) };
      }
      case 'find_param_values': {
        const r = await inject(
          'POST',
          `/api/templates/${enc(a.reportId as string)}/params/${enc(a.param as string)}/options`,
          { params: a.params },
        );
        if (r.status !== 200) return { result: errorOf(r) };
        return {
          result: shapeOptions(r.body as ParamOptionsResult, a.search as string | undefined),
        };
      }
      default: {
        // propose_run: доступ — через эндпоинт; проверка параметров — та же, что при формировании.
        const reportId = a.reportId as string;
        const f = await form(reportId);
        if ('error' in f) return { result: f.error };
        // значения от модели — unknown: объект вместо скаляра отсекаем до resolveParams
        const input = ParamsInput.safeParse(a.params);
        if (!input.success)
          return {
            result: {
              error: 'invalid params: values must be strings, numbers, booleans, null or arrays',
            },
          };
        const full = await loadTemplateFull(deps.db, reportId);
        let resolved: Record<string, ParamValue>;
        try {
          resolved = resolveParams(full.params, input.data);
          await validateQueryParams(deps, full, resolved);
        } catch (e) {
          if (e instanceof AppError && e.code === 'VALIDATION')
            return { result: { error: e.textIn(locale), fields: e.detailsIn(locale) } };
          throw e;
        }
        return {
          card: {
            reportId,
            reportName: f.details.name,
            params: resolved,
            display: await display(reportId, resolved),
            outputFormats: f.details.outputFormats,
            defaultOutput: f.details.defaultOutput,
          },
        };
      }
    }
  }

  return { specs: SPECS, run };
}
