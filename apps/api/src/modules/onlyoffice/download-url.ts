/** Публичный префикс Document Server за nginx (и dev-прокси Vite). */
const PUBLIC_PREFIX = '/onlyoffice/';
const CACHE_PREFIX = '/cache/files/';

/**
 * Ссылка на результат из callback OnlyOffice → адрес во внутренней сети.
 *
 * Document Server строит ссылку от публичного origin (X-Forwarded-Host), который из контейнера API
 * недоступен. Хост и протокол исходной ссылки отбрасываются целиком: скачиваем только из кэша
 * Document Server по внутреннему адресу. Query сохраняется — md5/expires подписывают путь, а не хост.
 * Возвращает null, если ссылка не разбирается или ведёт не в /cache/files/.
 */
export function toInternalDownloadUrl(publicUrl: string, internalBase: string): string | null {
  let url: URL;
  try {
    url = new URL(publicUrl);
  } catch {
    return null;
  }
  // new URL уже нормализовал «..» и «%2e%2e»; закодированные разделители путь не содержит.
  let path = url.pathname;
  if (/%2f|%5c|\\/i.test(path)) return null;
  if (path.startsWith(PUBLIC_PREFIX)) path = path.slice(PUBLIC_PREFIX.length - 1);
  if (!path.startsWith(CACHE_PREFIX)) return null;
  return `${internalBase.replace(/\/$/, '')}${path}${url.search}`;
}
