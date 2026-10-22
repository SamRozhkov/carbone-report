// Язык запроса (§44.4): X-Locale → Accept-Language → DEFAULT_LOCALE.
import { isLocale, resolveLocale, type Locale } from '@carbone-reports/shared/i18n';
import type { IncomingHttpHeaders } from 'node:http';
import type { App } from '../app';

declare module 'fastify' {
  interface FastifyRequest {
    /** Язык ответа: переводы ошибок, язык редактора OnlyOffice. */
    locale: Locale;
  }
}

/** Внутренние маршруты (Document Server, рендер) — всегда язык по умолчанию. */
const INTERNAL = /^\/internal\//;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

/**
 * Теги Accept-Language по убыванию q; при равных q — в порядке заголовка.
 * `*`, q=0 и элементы с неверным q пропускаются.
 */
export function parseAcceptLanguage(header: string): string[] {
  const items: { tag: string; q: number; i: number }[] = [];
  header.split(',').forEach((part, i) => {
    const [rawTag, ...rawParams] = part.split(';');
    const tag = rawTag!.trim();
    if (!tag || tag === '*') return;
    let q = 1;
    for (const p of rawParams) {
      const [name, value] = p.split('=').map((s) => s.trim());
      if (name?.toLowerCase() === 'q')
        q = /^(0(\.\d{0,3})?|1(\.0{0,3})?)$/.test(value ?? '') ? Number(value) : NaN;
    }
    if (q > 0) items.push({ tag, q, i });
  });
  return items.sort((a, b) => b.q - a.q || a.i - b.i).map((x) => x.tag);
}

export function requestLocale(
  req: { headers: IncomingHttpHeaders; url: string },
  defaultLocale: Locale,
): Locale {
  if (INTERNAL.test(req.url)) return defaultLocale;
  const explicit = first(req.headers['x-locale'])?.trim();
  if (isLocale(explicit)) return explicit;
  const accept = first(req.headers['accept-language']);
  return accept ? resolveLocale(parseAcceptLanguage(accept), defaultLocale) : defaultLocale;
}

/** Ставит req.locale каждому запросу; регистрируется первым, до хуков, которые могут ответить ошибкой. */
export function registerRequestLocale(app: App, defaultLocale: Locale): void {
  // Значение по умолчанию — и для ошибок, случившихся до onRequest.
  app.decorateRequest('locale', defaultLocale);
  app.addHook('onRequest', async (req) => {
    req.locale = requestLocale(req, defaultLocale);
  });
}
