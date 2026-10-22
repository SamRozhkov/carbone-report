import { zodLocale, type Locale } from '@carbone-reports/shared/i18n';
import { createTranslator } from '@carbone-reports/shared/i18n/server';
import type { FastifySchemaCompiler, FastifySchemaValidationError } from 'fastify';
import { safeParse, type $ZodIssue, type $ZodType } from 'zod/v4/core';
import type { App } from '../app';

type Param = string | number | Msg | IssueText;
type Params = Record<string, Param>;

/**
 * Сообщение ошибки: ключ каталога errors (без префикса `errors:`) и параметры.
 * Параметр-сообщение (`text(…)`, `issueText(…)`) переводится на тот же язык и подставляется
 * готовым текстом.
 */
export type Msg = { key: string; params?: Params };

/** Переводимый текст в details и в параметрах: обработчик переводит его на язык запроса. */
export class Text implements Msg {
  constructor(
    readonly key: string,
    readonly params?: Params,
  ) {}
}
export const text = (key: string, params?: Params) => new Text(key, params);

/**
 * Сообщение zod (issue из localizedSafeParse) в параметре или в details: текст строится на языке
 * запроса так же, как у ошибок проверки тела запроса. Issue содержит ввод — в ответ попадает
 * только текст.
 */
export class IssueText {
  declare readonly issue: $ZodIssue;

  constructor(issue: $ZodIssue) {
    // Неперечисляемое: issue содержит ввод запроса — не попадает в журнал и сериализацию.
    Object.defineProperty(this, 'issue', { value: issue });
  }
}
export const issueText = (issue: $ZodIssue) => new IssueText(issue);

const renderParam = (v: Param, locale: Locale): string | number =>
  v instanceof IssueText
    ? issueMessage(v.issue, locale)
    : typeof v === 'object'
      ? translateMsg(locale, v)
      : v;

export function translateMsg(locale: Locale, msg: Msg): string {
  const params =
    msg.params &&
    Object.fromEntries(Object.entries(msg.params).map(([k, v]) => [k, renderParam(v, locale)]));
  return createTranslator(locale)(`errors:${msg.key}`, params);
}

/** Текст по-русски — для журнала, err.message и сохраняемых в БД текстов. */
export const ruText = (key: string, params?: Params) => translateMsg('ru', { key, params });

export class AppError extends Error {
  /** details по-русски (журнал, тесты); в ответ идут переведённые — detailsIn(locale). */
  public readonly details?: unknown;
  /** details как переданы: `text(…)`, `issueText(…)` и ключи `v:…` переводятся на язык запроса. */
  readonly #details: unknown;

  constructor(
    public readonly code: string,
    public readonly status: number,
    /** Ключ каталога errors — переводится на язык запроса (§44.4). */
    public readonly msg: Msg,
    details?: unknown,
    /** Внутренняя причина: только в лог, никогда в ответ. */
    public readonly internal?: unknown,
  ) {
    // Для журнала — по-русски.
    super(translateMsg('ru', msg));
    this.#details = details;
    if (details !== undefined) this.details = translateDetails(details, 'ru');
  }

  /** Текст ошибки на языке locale. */
  textIn(locale: Locale): string {
    return translateMsg(locale, this.msg);
  }

  /** details на языке locale. */
  detailsIn(locale: Locale): unknown {
    return translateDetails(this.#details, locale);
  }
}

export const badRequest = (key: string, params?: Params, details?: unknown) =>
  new AppError('BAD_REQUEST', 400, { key, params }, details);
export const unauthorized = () => new AppError('UNAUTHORIZED', 401, { key: 'unauthorized' });
export const forbidden = (key = 'forbidden', params?: Params) =>
  new AppError('FORBIDDEN', 403, { key, params });
/** `notFound('template')` → ключ `notFound.template` («шаблон не найден»). */
export const notFound = (what: string) =>
  new AppError('NOT_FOUND', 404, { key: `notFound.${what}` });
export const conflict = (key: string, params?: Params) =>
  new AppError('CONFLICT', 409, { key, params });

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
      // Неперечисляемое: issue содержит ввод запроса — не попадает в журнал и сериализацию.
      params: Object.defineProperty({}, 'issue', { value: issue, enumerable: false }) as {
        issue: $ZodIssue;
      },
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

/** Параметры сообщения `v:…`: у custom — заданные в схеме, у too_big/too_small — граница. */
function issueParams(issue: $ZodIssue): Record<string, unknown> | undefined {
  if (issue.code === 'custom') return issue.params;
  if (issue.code === 'too_big') return { maximum: Number(issue.maximum) };
  if (issue.code === 'too_small') return { minimum: Number(issue.minimum) };
  return undefined;
}

function issueMessage(issue: $ZodIssue, locale: Locale): string {
  const t = createTranslator(locale);
  const key = validationKey(issue.message);
  if (key) return t(key, issueParams(issue));
  if (issue.message !== ZOD_BUILTIN) return issue.message;
  const m = zodLocale(locale).localeError(issue as never);
  return (typeof m === 'string' ? m : m?.message) ?? t('errors:validation');
}

/**
 * safeParse, чьи issues переводятся на язык запроса через issueText: встроенные сообщения zod
 * строятся при переводе, а не на языке по умолчанию.
 */
export const localizedSafeParse = <T extends $ZodType>(schema: T, data: unknown) =>
  safeParse(schema, data, { reportInput: true, error: () => ZOD_BUILTIN });

/** details по-русски — как их увидит пользователь с языком ru (журнал, тесты). */
export const ruDetails = (details: unknown) => translateDetails(details, 'ru');

/**
 * Тексты в details AppError: `text(…)`, `issueText(…)` (в любом месте структуры) и ключи `v:…`
 * в полях message переводятся, прочее — как есть.
 */
function translateDetails(details: unknown, locale: Locale): unknown {
  if (details instanceof Text) return translateMsg(locale, details);
  if (details instanceof IssueText) return issueMessage(details.issue, locale);
  if (Array.isArray(details)) return details.map((d) => translateDetails(d, locale));
  if (details === null || typeof details !== 'object' || details.constructor !== Object)
    return details;
  return Object.fromEntries(
    Object.entries(details).map(([k, v]) => {
      const key = k === 'message' && typeof v === 'string' ? validationKey(v) : null;
      return [k, key ? createTranslator(locale)(key) : translateDetails(v, locale)];
    }),
  );
}

export function registerErrorHandler(app: App): void {
  app.setErrorHandler((err, req, reply) => {
    // Без хука языка (модульные тесты) — язык источника.
    const locale: Locale = req.locale ?? 'ru';
    const t = createTranslator(locale);
    if (err instanceof AppError) {
      if (err.internal !== undefined)
        req.log.warn({ err: err.internal, code: err.code }, err.message);
      // Ключа нет в каталоге (опечатка в коде) — в ответ общий текст, а не «errors:<ключ>».
      let message = err.textIn(locale);
      if (message === `errors:${err.msg.key}` || message === err.msg.key) {
        req.log.warn({ key: err.msg.key, code: err.code }, 'нет ключа в каталоге errors');
        message = t(err.status >= 500 ? 'errors:internal' : 'errors:badRequest');
      }
      const body: { code: string; message: string; details?: unknown } = {
        code: err.code,
        message,
      };
      if (err.details !== undefined) body.details = err.detailsIn(locale);
      return reply.status(err.status).send({ error: body });
    }
    if (isRequestValidation(err)) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION',
          message: t('errors:validation'),
          details: err.validation.map((v) => ({
            path: v.instancePath,
            message: issueMessage(v.params.issue, locale),
          })),
        },
      });
    }
    const status = (err as { statusCode?: number }).statusCode;
    if (status && status >= 400 && status < 500) {
      const code = (err as { code?: string }).code;
      const msg = (code && CLIENT_ERROR_MESSAGES[code]) || { key: 'badRequest' };
      return reply.status(status).send({
        error: { code: code ?? 'BAD_REQUEST', message: translateMsg(locale, msg) },
      });
    }
    req.log.error(err);
    return reply.status(500).send({ error: { code: 'INTERNAL', message: t('errors:internal') } });
  });
}
