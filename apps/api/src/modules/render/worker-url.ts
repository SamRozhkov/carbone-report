/**
 * Путь к потоку рендера. В prod tsup собирает его в dist/render-worker.js рядом с dist/server.js
 * (этот модуль вшит в server.js); в dev (tsx) — исходник worker.ts, загрузчик tsx передаётся потоку.
 */
export function renderWorkerUrl(): { url: URL; execArgv?: string[] } {
  if (import.meta.url.endsWith('.ts')) {
    return { url: new URL('./worker.ts', import.meta.url), execArgv: ['--import', 'tsx'] };
  }
  return { url: new URL('./render-worker.js', import.meta.url) };
}
