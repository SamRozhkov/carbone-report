import type {
  ParamOptionsResult,
  ParamsInput,
  ParamValue,
  TemplateParam,
} from '@carbone-reports/shared';
import type { AppDeps } from '../../deps';
import { AppError, notFound } from '../../lib/errors';
import type { TemplateFull } from '../templates/service';
import { loadParamOptions, type QueryLimits } from './executor';
import { orderParams, paramRefs } from './param-deps';
import { checkParam, isEmptyValue } from './params';

const limitsOf = (deps: AppDeps): QueryLimits => ({
  timeoutMs: deps.config.queryTimeoutMs,
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
): Promise<void> {
  const order = orderParams(full.params).filter((d) => d.type === 'query');
  const toCheck = order.filter((d) => !isEmptyValue(resolved[d.name]));
  if (toCheck.length === 0) return;
  const { pool, name } = await deps.sources.get(full.row.datasourceId);
  const lists = await loadParamOptions(
    pool,
    name,
    toCheck.map((def) => ({ def, params: resolved })),
    limitsOf(deps),
  );
  const fields: Record<string, string> = {};
  toCheck.forEach((def, i) => {
    const allowed = new Set(lists[i]!.map((o) => String(o.value)));
    const v = resolved[def.name];
    const vals = Array.isArray(v) ? v : [v as string | number];
    if (!vals.every((x) => allowed.has(String(x)))) fields[def.name] = 'значение недоступно';
  });
  if (Object.keys(fields).length > 0) {
    throw new AppError('VALIDATION', 400, 'неверные параметры', { fields });
  }
}

/**
 * Варианты одного параметра типа query при текущих значениях родителей.
 * Обязательный родитель без допустимого значения → waitingFor, запрос не выполняется.
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
  const params: Record<string, ParamValue> = {};
  const waitingFor: string[] = [];
  for (const ref of paramRefs(def)) {
    const parent = byName.get(ref);
    // Ссылки проверены при сохранении; неизвестную readQuery отклонит с ошибкой CONFIG.
    if (!parent) continue;
    const { value, error } = checkParam(parent, Object.hasOwn(input, ref) ? input[ref] : undefined);
    if (error || isEmptyValue(value)) {
      if (parent.required) waitingFor.push(ref);
      params[ref] = null;
    } else {
      params[ref] = value;
    }
  }
  if (waitingFor.length > 0) return { options: [], waitingFor };

  const { pool, name } = await deps.sources.get(full.row.datasourceId);
  const [options] = await loadParamOptions(pool, name, [{ def, params }], limitsOf(deps));
  return { options: options! };
}
