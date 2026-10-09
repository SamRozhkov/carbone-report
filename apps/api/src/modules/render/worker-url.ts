/**
 * Путь к потоку рендера. В prod tsup собирает его в dist/render-worker.js рядом с dist/server.js
 * (этот модуль вшит в server.js); в dev (tsx) — worker-dev.mjs, который сам подключает tsx
 * и загружает исходник worker.ts. execArgv пустой: флаги главного процесса (--inspect и т. п.)
 * потоку не нужны.
 */
export function renderWorkerUrl(): { url: URL; execArgv?: string[] } {
  if (import.meta.url.endsWith('.ts')) {
    return { url: new URL('./worker-dev.mjs', import.meta.url), execArgv: [] };
  }
  return { url: new URL('./render-worker.js', import.meta.url) };
}
