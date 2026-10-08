import type { OutputFormat } from '@carbone-reports/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { triggerDownload } from '../lib/download';
import { apiFile } from './client';
import { runFileUrl } from './endpoints';

export interface RunFileRequest {
  runId: string;
  format: OutputFormat;
}

/**
 * Скачивание файла запуска с ожиданием сборки (§24.6): пока сервер собирает формат из снимка, виден
 * `pending`; ошибка — в `error`. Готовый файл сохраняется тем же triggerDownload через blob-ссылку.
 */
export function useRunDownload() {
  const queryClient = useQueryClient();
  const m = useMutation({
    mutationFn: async ({ runId, format }: RunFileRequest) => {
      const { blob, filename } = await apiFile(runFileUrl(runId, { format }));
      const url = URL.createObjectURL(blob);
      triggerDownload(url, filename);
      // Ссылка нужна браузеру, пока он забирает файл; потом память освобождается.
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    },
    // Новый собранный формат появится в readyFormats истории.
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['runs'] }),
  });
  return {
    save: m.mutate,
    pending: m.isPending ? m.variables : undefined,
    error: m.error,
    reset: m.reset,
  };
}
