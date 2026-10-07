const DISABLED = /is disabled in the Community Edition/;
/** Имя — только идентификатор из той же фразы; Source с кавычками сюда не попадает. */
const NAME = /Formatter "([A-Za-z_][A-Za-z0-9_]*)" is disabled in the Community Edition/;

/**
 * Ошибка Carbone «Formatter "X" is disabled in the Community Edition» → сообщение для пользователя.
 * Другие ошибки — null. Имя не разобрать — «форматтер».
 */
export function communityErrorMessage(carboneError: string): string | null {
  if (!DISABLED.test(carboneError)) return null;
  const name = NAME.exec(carboneError)?.[1] ?? 'форматтер';
  return `в шаблоне используется ${name} — недоступно в бесплатной версии Carbone, см. «Справка по шаблонам»`;
}
