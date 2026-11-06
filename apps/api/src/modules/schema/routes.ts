// Схема источника, проверка SQL и пробная строка для авторов шаблонов (§51.2, §53.2).
import { CheckQueryBody, IdParams } from '@carbone-reports/shared';
import { z } from 'zod';
import type { App } from '../../app';
import type { AppDeps } from '../../deps';
import { notFound } from '../../lib/errors';
import type { Guards } from '../auth/guards';
import { checkQuery, probeQuery, withReadOnly } from '../queries/executor';
import { loadTemplate } from '../templates/service';
import { describeTable, listTables } from './introspect';

export function registerSchemaRoutes(app: App, deps: AppDeps, guards: Guards): void {
  const pre = { preHandler: guards.requireTemplateEdit };
  const source = async (id: string) =>
    deps.sources.get((await loadTemplate(deps.db, id)).datasourceId);
  const timeout = deps.config.queryTimeoutMs;

  app.get(
    '/api/templates/:id/schema/tables',
    {
      ...pre,
      schema: {
        params: IdParams,
        querystring: z.object({ search: z.string().max(200).optional() }),
      },
    },
    async (req) => {
      const { pool, name } = await source(req.params.id);
      return withReadOnly(pool, name, timeout, (tx) => listTables(tx.client, req.query.search));
    },
  );

  app.get(
    '/api/templates/:id/schema/tables/:name',
    { ...pre, schema: { params: IdParams.extend({ name: z.string().min(1).max(200) }) } },
    async (req) => {
      const { pool, name } = await source(req.params.id);
      const t = await withReadOnly(pool, name, timeout, (tx) =>
        describeTable(tx.client, req.params.name),
      );
      if (!t) throw notFound('table');
      return t;
    },
  );

  app.post(
    '/api/templates/:id/queries/check',
    { ...pre, schema: { params: IdParams, body: CheckQueryBody } },
    async (req) => {
      const { pool, name } = await source(req.params.id);
      return checkQuery(pool, name, req.body.sql, timeout, req.locale);
    },
  );

  // Пробная строка: только форма вложенных массивов, без значений (§53.2).
  app.post(
    '/api/templates/:id/queries/probe',
    { ...pre, schema: { params: IdParams, body: CheckQueryBody } },
    async (req) => {
      const { pool, name } = await source(req.params.id);
      return probeQuery(pool, name, req.body.sql, timeout, req.locale);
    },
  );
}
