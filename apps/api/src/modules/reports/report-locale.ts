// Язык отчёта (§45.2): определяется один раз на построение и передаётся дальше — в Carbone,
// OnlyOffice и постобработку PDF; запуск хранит его для подписи и сборки других форматов.
import { isLocale, type Locale, type ReportLocale } from '@carbone-reports/shared/i18n';

/**
 * Язык шаблона; для 'user' — язык профиля строящего (если это один из LOCALES), иначе язык
 * запроса (X-Locale → Accept-Language → DEFAULT_LOCALE, lib/locale.ts). Значение шаблона вне
 * LOCALES (ограничения в БД нет — прямой SQL, восстановление) — ru, как у runLocale.
 */
export function resolveReportLocale(
  setting: ReportLocale,
  userLocale: string | null,
  reqLocale: Locale,
): Locale {
  if (setting !== 'user') return isLocale(setting) ? setting : 'ru';
  return isLocale(userLocale) ? userLocale : reqLocale;
}

/** Язык запуска: у запусков до 2.14.0 (NULL) и при неизвестном значении — ru. */
export function runLocale(run: { reportLocale: string | null }): Locale {
  return isLocale(run.reportLocale) ? run.reportLocale : 'ru';
}
