type Listener = () => void;

const listeners = new Set<Listener>();
let reported = false;

/** Ответ 503 с кодом maintenance (§26.5): приложение переключается на экран обслуживания. */
export function reportMaintenance(): void {
  if (reported) return;
  reported = true;
  for (const l of listeners) l();
}

export const isMaintenanceReported = () => reported;

export function onMaintenance(listener: Listener): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** Только для тестов: экран обслуживания снимается перезагрузкой страницы. */
export function resetMaintenance(): void {
  reported = false;
}
