import type { TemplateParam } from '@carbone-reports/shared';
import { AppError } from '../../lib/errors';
import { parseSqlParams, SqlParamError } from './sql-params';

/** Уникальные имена :x из SQL параметра типа query в порядке появления. */
export function paramRefs(def: TemplateParam): string[] {
  if (def.type !== 'query' || def.sql === null) return [];
  return [...new Set(parseSqlParams(def.sql).names)];
}

// Путь — JSON-pointer, как у ошибок схемы (ajv instancePath): fieldErrors() на фронте превращает '/1/sql' в '1.sql'.
function fail(index: number, message: string): never {
  throw new AppError('VALIDATION', 400, 'неверные параметры', [{ path: `/${index}/sql`, message }]);
}

/**
 * Топологический порядок: родители раньше детей, среди готовых сохраняется исходный порядок.
 * Бросает VALIDATION у строки с неизвестной ссылкой, ссылкой на себя или циклом.
 */
export function orderParams(defs: TemplateParam[]): TemplateParam[] {
  const index = new Map(defs.map((d, i) => [d.name, i]));
  const deps: number[][] = defs.map((def, i) => {
    let names: string[];
    try {
      names = paramRefs(def);
    } catch (e) {
      if (e instanceof SqlParamError) return fail(i, e.message);
      throw e;
    }
    return names.map((name) => {
      const j = index.get(name);
      if (j === undefined) return fail(i, `неизвестный параметр :${name}`);
      if (j === i) return fail(i, 'параметр не может ссылаться на себя');
      return j;
    });
  });

  const done = new Array<boolean>(defs.length).fill(false);
  const out: TemplateParam[] = [];
  let progressed = true;
  while (out.length < defs.length && progressed) {
    progressed = false;
    // Берём по одной вершине: минимальный индекс среди готовых (стабильный порядок).
    for (let i = 0; i < defs.length; i++) {
      if (!done[i] && deps[i]!.every((j) => done[j])) {
        done[i] = true;
        out.push(defs[i]!);
        progressed = true;
        break;
      }
    }
  }
  if (out.length === defs.length) return out;

  const start = done.indexOf(false);
  const stack: number[] = [];
  const onStack = new Set<number>();
  const visit = (v: number): number[] | null => {
    stack.push(v);
    onStack.add(v);
    for (const w of deps[v]!) {
      if (done[w]) continue;
      if (onStack.has(w)) return [...stack.slice(stack.indexOf(w)), w];
      const found = visit(w);
      if (found) return found;
    }
    stack.pop();
    onStack.delete(v);
    return null;
  };
  const cycle = visit(start) ?? [start, start];
  return fail(cycle[0]!, `циклическая зависимость: ${cycle.map((i) => defs[i]!.name).join(' → ')}`);
}
