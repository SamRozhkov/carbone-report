// Поток пула рендера: собирает отчёт встроенной сборкой Carbone (формат шаблона).
// Глобальные carbone.set()/reset() не вызываем: lang, timezone и настройки загрузки изображений
// всегда приходят в options. Предупреждения рендера (R6) уходят пулу вместе с файлом.
import { parentPort } from 'node:worker_threads';
import carbone from '@carbone-reports/carbone';
import type { RenderOptions } from './pool';

interface Request {
  id: number;
  template: Uint8Array;
  ext: string;
  data: string;
  options: RenderOptions;
}

const port = parentPort;
if (!port) throw new Error('worker.ts запускается только как поток пула рендера');

port.on('message', (m: Request) => {
  const template = Buffer.from(m.template.buffer, m.template.byteOffset, m.template.byteLength);
  carbone.renderBufferWithWarnings(template, m.ext, JSON.parse(m.data), m.options).then(
    ({ buffer: out, warnings }) => {
      // Передаём ArrayBuffer без копии, если буфер занимает его целиком; иначе копируем.
      const ab = out.buffer;
      const whole =
        ab instanceof ArrayBuffer && out.byteOffset === 0 && out.byteLength === ab.byteLength;
      const bytes = whole ? new Uint8Array(ab, 0, out.byteLength) : new Uint8Array(out);
      port.postMessage({ id: m.id, ok: true, out: bytes, warnings }, [bytes.buffer as ArrayBuffer]);
    },
    (err: unknown) => {
      port.postMessage({
        id: m.id,
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      });
    },
  );
});

// Модули загружены — пул может отдавать задачи.
port.postMessage({ ready: true });
