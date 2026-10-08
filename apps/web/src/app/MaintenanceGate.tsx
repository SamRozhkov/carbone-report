import { useSyncExternalStore, type ReactNode } from 'react';
import { isMaintenanceReported, onMaintenance } from '../api/maintenance';
import { MaintenanceScreen } from '../components/MaintenanceScreen';

/** Над роутером: после первого ответа 503 maintenance всё приложение заменяет экран обслуживания. */
export function MaintenanceGate({ children }: { children: ReactNode }) {
  const active = useSyncExternalStore(onMaintenance, isMaintenanceReported);
  return active ? <MaintenanceScreen /> : <>{children}</>;
}
