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
