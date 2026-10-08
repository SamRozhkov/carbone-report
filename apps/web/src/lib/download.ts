/** Скачивание через временную ссылку: браузер берёт имя файла из Content-Disposition. */
export function triggerDownload(url: string, filename?: string): void {
  const a = document.createElement('a');
  a.href = url;
  if (filename) a.download = filename;
  else a.setAttribute('download', '');
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Имя файла из Content-Disposition: сначала `filename*=UTF-8''…` (кириллица), потом `filename="…"`. */
export function filenameFromDisposition(header: string | null): string | undefined {
  if (!header) return undefined;
  const star = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1]!.trim());
    } catch {
      // битая кодировка — пробуем обычное имя
    }
  }
  return /filename="([^"]*)"/i.exec(header)?.[1] || undefined;
}
