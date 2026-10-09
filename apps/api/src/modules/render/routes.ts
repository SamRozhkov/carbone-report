import { z } from 'zod';
import type { App } from '../../app';
import { AppError } from '../../lib/errors';
import { MIME } from '../../lib/http';
import type { RenderHandoff } from './handoff';

/** Разовая выдача собранного отчёта Document Server для конвертации. Снаружи /internal/* закрыт в nginx. */
export function registerRenderRoutes(app: App, files: RenderHandoff): void {
  app.get(
    '/internal/render-files/:id',
    {
      schema: {
        params: z.object({ id: z.string().regex(/^[0-9a-f]{32}$/) }),
        querystring: z.object({ t: z.string().optional() }),
      },
    },
    async (req, reply) => {
      const got = await files.take(req.params.id, req.query.t ?? '');
      if (got === 'forbidden') throw new AppError('FORBIDDEN', 403, 'неверный токен файла');
      if (got === 'gone') throw new AppError('NOT_FOUND', 404, 'файл уже выдан или устарел');
      return reply.header('content-type', MIME[got.ext]).send(got.file);
    },
  );
}
