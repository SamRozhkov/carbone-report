import { hasZodFastifySchemaValidationErrors } from 'fastify-type-provider-zod';
import type { App } from '../app';

export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
    public readonly details?: unknown,
    /** Внутренняя причина: только в лог, никогда в ответ. */
    public readonly internal?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) =>
  new AppError('BAD_REQUEST', 400, message, details);
export const unauthorized = () => new AppError('UNAUTHORIZED', 401, 'требуется вход');
export const forbidden = () => new AppError('FORBIDDEN', 403, 'недостаточно прав');
export const notFound = (what: string) => new AppError('NOT_FOUND', 404, `${what} не найден`);
export const conflict = (message: string) => new AppError('CONFLICT', 409, message);

const CLIENT_ERROR_MESSAGES: Record<string, string> = {
  FST_REQ_FILE_TOO_LARGE: 'файл больше 20 МБ',
  FST_FILES_LIMIT: 'слишком много файлов или полей в запросе',
  FST_PARTS_LIMIT: 'слишком много файлов или полей в запросе',
  FST_FIELDS_LIMIT: 'слишком много файлов или полей в запросе',
  FST_ERR_CTP_INVALID_JSON_BODY: 'некорректный JSON в теле запроса',
  FST_ERR_CTP_EMPTY_JSON_BODY: 'некорректный JSON в теле запроса',
  FST_ERR_CTP_BODY_TOO_LARGE: 'тело запроса слишком большое',
  FST_ERR_CTP_INVALID_MEDIA_TYPE: 'неподдерживаемый тип содержимого',
};

export function registerErrorHandler(app: App): void {
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      if (err.internal !== undefined)
        req.log.warn({ err: err.internal, code: err.code }, err.message);
      const body: { code: string; message: string; details?: unknown } = {
        code: err.code,
        message: err.message,
      };
      if (err.details !== undefined) body.details = err.details;
      return reply.status(err.status).send({ error: body });
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION',
          message: 'неверные данные запроса',
          details: err.validation.map((v) => ({ path: v.instancePath, message: v.message })),
        },
      });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      const code = (err as { code?: string }).code;
      return reply.status(status).send({
        error: {
          code: code ?? 'BAD_REQUEST',
          message: (code && CLIENT_ERROR_MESSAGES[code]) || 'некорректный запрос',
        },
      });
    }
    req.log.error(err);
    return reply
      .status(500)
      .send({ error: { code: 'INTERNAL', message: 'внутренняя ошибка сервера' } });
  });
}
