import { zodLocale, type Locale } from '@carbone-reports/shared/i18n';
import { createTranslator, resources, type Translate } from '@carbone-reports/shared/i18n/server';
import type { FastifySchemaCompiler, FastifySchemaValidationError } from 'fastify';
import { safeParse, type $ZodIssue, type $ZodType } from 'zod/v4/core';
import type { App } from '../app';

/** Сообщение ошибки: ключ каталога errors (без префикса `errors:`) и параметры. */
export type Msg = { key: string; params?: Record<string, string | number> };

const translate = (t: Translate, msg: Msg | string) =>
  typeof msg === 'string' ? msg : t(`errors:${msg.key}`, msg.params);

export class AppError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    /**
     * Ключ каталога errors — переводится на язык запроса. Строка — готовый русский текст:
     * временно, пока вызовы не переведены на ключи (§44.4).
     */
    public readonly msg: Msg | string,
    public readonly details?: unknown,
    /** Внутренняя причина: только в лог, никогда в ответ. */
    public readonly internal?: unknown,
  ) {
    // Для журнала — по-русски.
    super(translate(createTranslator('ru'), msg));
  }
}

type Params = Msg['params'];

/** Есть ли ключ в каталоге errors (с учётом форм множественного числа). */
function isErrorKey(key: string): boolean {
  let node: unknown = resources.ru.errors;
  const parts = key.split('.');
  const last = parts.pop()!;
  for (const p of parts) {
    if (node === null || typeof node !== 'object') return false;
    node = (node as Record<string, unknown>)[p];
  }
  if (node === null || typeof node !== 'object') return false;
  const obj = node as Record<string, unknown>;
  return typeof obj[last] === 'string' || typeof obj[`${last}_other`] === 'string';
}

/**
 * Ключ каталога или — временно, до перевода вызовов на ключи — прежний русский текст:
 * строка без параметров, которой нет среди ключей errors, отдаётся как есть.
 */
const msgOf = (keyOrText: string, params?: Params): Msg | string =>
  params === undefined && !isErrorKey(keyOrText) ? keyOrText : { key: keyOrText, params };

export const badRequest = (key: string, params?: Params, details?: unknown) =>
  new AppError('BAD_REQUEST', 400, msgOf(key, params), details);
export const unauthorized = () => new AppError('UNAUTHORIZED', 401, { key: 'unauthorized' });
export const forbidden = (key = 'forbidden', params?: Params) =>
  new AppError('FORBIDDEN', 403, msgOf(key, params));
/** `notFound('template')` → ключ `notFound.template`; прежняя форма `notFound('шаблон')` — «шаблон не найден». */
export const notFound = (what: string) =>
  new AppError(
    'NOT_FOUND',
    404,
    isErrorKey(`notFound.${what}`) ? { key: `notFound.${what}` } : `${what} не найден`,
  );
export const conflict = (key: string, params?: Params) =>
  new AppError('CONFLICT', 409, msgOf(key, params));

const CLIENT_ERROR_MESSAGES: Record<string, Msg> = {
  FST_REQ_FILE_TOO_LARGE: { key: 'fileTooLarge', params: { size: 20 } },
  FST_FILES_LIMIT: { key: 'tooManyParts' },
  FST_PARTS_LIMIT: { key: 'tooManyParts' },
  FST_FIELDS_LIMIT: { key: 'tooManyParts' },
  FST_ERR_CTP_INVALID_JSON_BODY: { key: 'invalidJson' },
  FST_ERR_CTP_EMPTY_JSON_BODY: { key: 'invalidJson' },
  FST_ERR_CTP_BODY_TOO_LARGE: { key: 'bodyTooLarge' },
  FST_ERR_CTP_INVALID_MEDIA_TYPE: { key: 'unsupportedMediaType' },
};

/**
 * Встроенное сообщение zod: текст строится в обработчике на языке запроса. Сообщения,
 * заданные в схеме (`min(1, 'v:…')`, `ctx.addIssue({ message })`), идут раньше и не заменяются.
 */
const ZOD_BUILTIN = '\u0000zod';
const REQUEST_VALIDATION = Symbol('requestValidation');

type RequestValidationError = FastifySchemaValidationError & {
  [REQUEST_VALIDATION]: true;
  params: { issue: $ZodIssue };
};

/**
 * Проверка запроса схемой zod. В отличие от validatorCompiler из fastify-type-provider-zod 7
 * (у него в `validation[i].params` — поля issue без `code`/`path`/`message`, а `input` не
 * сохраняется), отдаёт исходный issue целиком в `validation[i].params.issue` — с `input`
 * (нужен сообщениям invalid_type) и признаком встроенного сообщения.
 */
export const validatorCompiler: FastifySchemaCompiler<$ZodType> =
  ({ schema }) =>
  (data) => {
    const r = safeParse(schema, data, { reportInput: true, error: () => ZOD_BUILTIN });
    if (r.success) return { value: r.data };
    const validation: RequestValidationError[] = r.error.issues.map((issue) => ({
      [REQUEST_VALIDATION]: true,
      keyword: issue.code,
      instancePath: `/${issue.path.join('/')}`,
      schemaPath: `#/${issue.path.join('/')}/${issue.code}`,
      message: issue.message,
      params: { issue },
    }));
    return { error: validation as unknown as Error };
  };

function isRequestValidation(err: unknown): err is { validation: RequestValidationError[] } {
  const v = (err as { validation?: unknown } | null)?.validation;
  return Array.isArray(v) && v.length > 0 && (v[0] as RequestValidationError)[REQUEST_VALIDATION];
}

/** `v:<ключ>` — ключ каталога validation (двоеточие i18next приняло бы `v` за пространство имён). */
const validationKey = (message: string) =>
  message.startsWith('v:') ? `validation:${message.slice(2)}` : null;

function issueMessage(issue: $ZodIssue, locale: Locale, t: Translate): string {
  const key = validationKey(issue.message);
  if (key) return t(key);
  if (issue.message !== ZOD_BUILTIN) return issue.message;
  const m = zodLocale(locale).localeError(issue as never);
  return (typeof m === 'string' ? m : m?.message) ?? t('errors:validation');
}

/** Тексты полей в details AppError: ключи `v:…` переводятся, прочее — как есть. */
function translateDetails(details: unknown, t: Translate): unknown {
  if (!Array.isArray(details)) return details;
  return details.map((d: unknown) => {
    const message = (d as { message?: unknown } | null)?.message;
    const key = typeof message === 'string' ? validationKey(message) : null;
    return key ? { ...(d as object), message: t(key) } : d;
  });
}

export function registerErrorHandler(app: App): void {
  app.setErrorHandler((err, req, reply) => {
    // Без хука языка (модульные тесты) — язык источника.
    const locale: Locale = req.locale ?? 'ru';
    const t = createTranslator(locale);
    if (err instanceof AppError) {
      if (err.internal !== undefined)
        req.log.warn({ err: err.internal, code: err.code }, err.message);
      const body: { code: string; message: string; details?: unknown } = {
        code: err.code,
        message: translate(t, err.msg),
      };
      if (err.details !== undefined) body.details = translateDetails(err.details, t);
      return reply.status(err.status).send({ error: body });
    }
    if (isRequestValidation(err)) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION',
          message: t('errors:validation'),
          details: err.validation.map((v) => ({
            path: v.instancePath,
            message: issueMessage(v.params.issue, locale, t),
          })),
        },
      });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      const code = (err as { code?: string }).code;
      const msg = (code && CLIENT_ERROR_MESSAGES[code]) || { key: 'badRequest' };
      return reply.status(status).send({
        error: { code: code ?? 'BAD_REQUEST', message: translate(t, msg) },
      });
    }
    req.log.error(err);
    return reply.status(500).send({ error: { code: 'INTERNAL', message: t('errors:internal') } });
  });
}
