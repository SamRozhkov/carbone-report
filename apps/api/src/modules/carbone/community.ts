const DISABLED = /is disabled in the Community Edition/;
/** Имя — только идентификатор из той же фразы; Source с кавычками сюда не попадает. */
const NAME = /Formatter "([A-Za-z_][A-Za-z0-9_]*)" is disabled in the Community Edition/;

/**
 * Ошибка Carbone «Formatter "X" is disabled in the Community Edition» → сообщение для пользователя
 * (ключ каталога errors). Другие ошибки — null. Имя не разобрать — «форматтер».
 */
/** Ключ каталога errors и параметры (форма Msg из lib/errors; без импорта — модуль читает scripts/help-check). */
export function communityError(
  carboneError: string,
): { key: string; params?: { name: string } } | null {
  if (!DISABLED.test(carboneError)) return null;
  const name = NAME.exec(carboneError)?.[1];
  return name
    ? { key: 'carbone.communityFormatter', params: { name } }
    : { key: 'carbone.communityUnknown' };
}
