import { DatasourceBody, IdParams, type DatasourceDto } from '@carbone-reports/shared';
import { asc, eq } from 'drizzle-orm';
import type { App } from '../../app';
import { datasources, templates, type DatasourceRow } from '../../db/schema';
import type { AppDeps } from '../../deps';
import { encryptSecret } from '../../lib/crypto';
import { badRequest, conflict, notFound } from '../../lib/errors';
import type { Guards } from '../auth/guards';
import { connParamsFromRow, testConnection } from './pools';

export const toDatasourceDto = (r: DatasourceRow): DatasourceDto => ({
  id: r.id,
  name: r.name,
  host: r.host,
  port: r.port,
  database: r.database,
  username: r.username,
  sslMode: r.sslMode,
  sslCa: r.sslCa,
  createdAt: r.createdAt.toISOString(),
});

export function registerDatasourceRoutes(app: App, deps: AppDeps, guards: Guards): void {
  const pre = { preHandler: guards.requireAdmin };
  const key = deps.config.encryptionKey;

  app.get('/api/datasources', pre, async () => {
    const rows = await deps.db.select().from(datasources).orderBy(asc(datasources.name));
    return rows.map(toDatasourceDto);
  });

  app.post('/api/datasources', { ...pre, schema: { body: DatasourceBody } }, async (req, reply) => {
    const { password, ...rest } = req.body;
    if (!password) throw badRequest('пароль обязателен');
    const [row] = await deps.db
      .insert(datasources)
      .values({ ...rest, passwordEnc: encryptSecret(password, key) })
      .returning();
    return reply.status(201).send(toDatasourceDto(row!));
  });

  app.patch(
    '/api/datasources/:id',
    { ...pre, schema: { params: IdParams, body: DatasourceBody } },
    async (req) => {
      const { password, ...rest } = req.body;
      const patch: Partial<DatasourceRow> = { ...rest };
      if (password) patch.passwordEnc = encryptSecret(password, key);
      const [row] = await deps.db
        .update(datasources)
        .set(patch)
        .where(eq(datasources.id, req.params.id))
        .returning();
      if (!row) throw notFound('источник данных');
      await deps.sources.invalidate(row.id);
      return toDatasourceDto(row);
    },
  );

  app.delete(
    '/api/datasources/:id',
    { ...pre, schema: { params: IdParams } },
    async (req, reply) => {
      const used = await deps.db
        .select({ id: templates.id })
        .from(templates)
        .where(eq(templates.datasourceId, req.params.id))
        .limit(1);
      if (used.length > 0) throw conflict('источник используется шаблонами');
      const [row] = await deps.db
        .delete(datasources)
        .where(eq(datasources.id, req.params.id))
        .returning();
      if (!row) throw notFound('источник данных');
      await deps.sources.invalidate(row.id);
      return reply.status(204).send();
    },
  );

  app.post('/api/datasources/test', { ...pre, schema: { body: DatasourceBody } }, async (req) => {
    if (!req.body.password) throw badRequest('пароль обязателен');
    return testConnection({ ...req.body, password: req.body.password });
  });

  app.post('/api/datasources/:id/test', { ...pre, schema: { params: IdParams } }, async (req) => {
    const [row] = await deps.db.select().from(datasources).where(eq(datasources.id, req.params.id));
    if (!row) throw notFound('источник данных');
    return testConnection(connParamsFromRow(row, key));
  });
}
