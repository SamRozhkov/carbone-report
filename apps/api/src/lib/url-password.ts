/** Разбирается ли строка как URL с хостом (`db:5432` разбирается как схема `db:` без хоста). */
export function hasHost(url: string): boolean {
  return URL.canParse(url) && new URL(url).hostname !== '';
}

/**
 * Пароль из отдельной переменной (DATABASE_PASSWORD, REDIS_PASSWORD) вставляется в URL с кодированием:
 * в пароле внешней базы могут быть @, /, #, % — подставленный шаблоном как есть, он сломал бы URL.
 * Пустой пароль — URL без изменений (compose передаёт пароль прямо в URL).
 */
export function withPassword(url: string, password: string | undefined): string {
  if (!password) return url;
  // Ни URL, ни пароль в сообщение не попадают. Без хоста сеттер password молча ничего не делает.
  if (!hasHost(url)) throw new Error('нужен URL вида scheme://user@host:port/…');
  const u = new URL(url);
  // Сеттер не кодирует %, поэтому кодируем сами: pg и ioredis раскодируют пароль обратно.
  u.password = encodeURIComponent(password);
  return u.toString();
}
