import type {
  ParamOptionsResult,
  ParamsInput,
  ParamValue,
  SelectOptionValue,
  TemplateParam,
} from '@carbone-reports/shared';
import type { AppDeps } from '../../deps';
import type { Deadline } from '../../lib/deadline';
import { AppError, notFound } from '../../lib/errors';
import type { TemplateFull } from '../templates/service';
import { loadParamOptions, type QueryLimits } from './executor';
import { orderParams, paramRefs } from './param-deps';
import { checkParam, isEmptyValue } from './params';

/** С `deadline` таймаут SQL — не дольше остатка общего срока отчёта. */
const limitsOf = (deps: AppDeps, deadline?: Deadline): QueryLimits => ({
  timeoutMs: deadline ? deadline.cap(deps.config.queryTimeoutMs) : deps.config.queryTimeoutMs,
  maxRows: deps.config.queryMaxRows,
});

/**
 * Строгая проверка: каждое заданное значение параметра типа query должно входить в его варианты,
 * посчитанные с уже разрешёнными значениями родителей. Все запросы — в одной транзакции.
 * Недопустимый родитель отмечается у самого родителя; SQL ребёнка с ним безопасен (только чтение,
 * значения передаются параметрами).
 */
export async function validateQueryParams(
  deps: AppDeps,
  full: TemplateFull,
  resolved: Record<string, ParamValue>,
  deadline?: Deadline,
): Promise<void> {
  const order = orderParams(full.params).filter((d) => d.type === 'query');
  const toCheck = order.filter((d) => !isEmptyValue(resolved[d.name]));
  if (toCheck.length === 0) return;
  const { pool, name } = await deps.sources.get(full.row.datasourceId);
  const lists = await loadParamOptions(
    pool,
    name,
    toCheck.map((def) => ({ def, params: resolved })),
    limitsOf(deps, deadline),
  );
  const fields: Record<string, string> = {};
  toCheck.forEach((def, i) => {
    if (!isAllowed(lists[i]!, resolved[def.name]!)) fields[def.name] = 'значение недоступно';
  });
  if (Object.keys(fields).length > 0) {
    throw new AppError('VALIDATION', 400, 'неверные параметры', { fields });
  }
}

/** Значение входит в варианты (для множественного — каждое). */
function isAllowed(options: SelectOptionValue[], v: ParamValue): boolean {
  const allowed = new Set(options.map((o) => String(o.value)));
  const vals = Array.isArray(v) ? v : [v as string | number];
  return vals.every((x) => allowed.has(String(x)));
}

/** Все предки параметра (транзитивно), каждому — множество прямых родителей def, через которые он достижим. */
function ancestorsVia(
  def: TemplateParam,
  byName: Map<string, TemplateParam>,
): Map<string, Set<string>> {
  const via = new Map<string, Set<string>>();
  for (const direct of paramRefs(def)) {
    const stack = [direct];
    while (stack.length > 0) {
      const name = stack.pop()!;
      const p = byName.get(name);
      if (!p) continue;
      let set = via.get(name);
      if (!set) via.set(name, (set = new Set()));
      if (set.has(direct)) continue;
      set.add(direct);
      stack.push(...paramRefs(p));
    }
  }
  return via;
}

/**
 * Варианты одного параметра типа query при текущих значениях родителей.
 * Обязательный родитель без значения → waitingFor, запрос не выполняется.
 * Строгая проверка, как при генерации: значение каждого предка типа query (транзитивно, в
 * топологическом порядке) должно входить в его варианты, посчитанные с его родителями.
 * Недопустимый предок → waitingFor получает прямого родителя, через которого он достижим, и
 * варианты ребёнка не выдаются. Всё — в одной read-only транзакции.
 */
export async function optionsForParam(
  deps: AppDeps,
  full: TemplateFull,
  paramName: string,
  input: ParamsInput,
): Promise<ParamOptionsResult> {
  const def = full.params.find((p) => p.name === paramName);
  if (!def || def.type !== 'query') throw notFound('параметр');

  const byName = new Map<string, TemplateParam>(full.params.map((p) => [p.name, p]));
  const resolve = (p: TemplateParam): ParamValue => {
    const { value, error } = checkParam(
      p,
      Object.hasOwn(input, p.name) ? input[p.name] : undefined,
    );
    return error ? null : value;
  };

  const waitingFor: string[] = [];
  for (const ref of paramRefs(def)) {
    const parent = byName.get(ref);
    // Ссылки проверены при сохранении; неизвестную readQuery отклонит с ошибкой CONFIG.
    if (parent && parent.required && isEmptyValue(resolve(parent))) waitingFor.push(ref);
  }
  if (waitingFor.length > 0) return { options: [], waitingFor };

  const via = ancestorsVia(def, byName);
  const params: Record<string, ParamValue> = {};
  for (const name of via.keys()) params[name] = resolve(byName.get(name)!);
  const toCheck = orderParams(full.params).filter(
    (p) => via.has(p.name) && p.type === 'query' && !isEmptyValue(params[p.name]),
  );

  const { pool, name } = await deps.sources.get(full.row.datasourceId);
  let bad: TemplateParam | undefined;
  const lists = await loadParamOptions(
    pool,
    name,
    [...toCheck, def].map((d) => ({ def: d, params })),
    limitsOf(deps),
    (i, options) => {
      const anc = toCheck[i];
      if (anc && !isAllowed(options, params[anc.name]!)) bad = anc;
      return bad !== undefined;
    },
  );
  if (bad) {
    const leads = via.get(bad.name)!;
    return { options: [], waitingFor: paramRefs(def).filter((r) => leads.has(r)) };
  }
  return { options: lists[toCheck.length]! };
}
