// Поток пула рендера: собирает отчёт встроенной сборкой Carbone (формат шаблона) или обрабатывает
// готовый PDF (§36.4, задача kind = pdf). Глобальные carbone.set()/reset() не вызываем: lang, timezone
// и настройки загрузки изображений всегда приходят в options. Предупреждения рендера (R6) уходят пулу.
import { parentPort } from 'node:worker_threads';
import carbone from '@carbone-reports/carbone';
import { postprocessPdf, type PdfPostJob } from '../pdf/postprocess';
import { prepareSignaturePdf, type SignPrepareJob } from '../pdf/sign/prepare';
import type { RenderOptions } from './pool';

interface Request {
  id: number;
  kind?: 'carbone' | 'pdf' | 'sign';
  template: Uint8Array;
  ext: string;
  data: string;
  options: RenderOptions;
  extra?: Uint8Array[];
}

type PdfJobData = Omit<PdfPostJob, 'attachments'> & {
  attachments: { placement: PdfPostJob['attachments'][number]['placement'] }[];
};

const port = parentPort;
if (!port) throw new Error('worker.ts запускается только как поток пула рендера');

async function handle(m: Request): Promise<{ buffer: Uint8Array; warnings: string[] }> {
  const template = Buffer.from(m.template.buffer, m.template.byteOffset, m.template.byteLength);
  if (m.kind === 'sign') {
    const buffer = await prepareSignaturePdf(template, JSON.parse(m.data) as SignPrepareJob);
    return { buffer, warnings: [] };
  }
  if (m.kind === 'pdf') {
    const job = JSON.parse(m.data) as PdfJobData;
    const extra = m.extra ?? [];
    const buffer = await postprocessPdf(template, {
      ...job,
      attachments: job.attachments.map((a, i) => ({ placement: a.placement, data: extra[i]! })),
    });
    return { buffer, warnings: [] };
  }
  return carbone.renderBufferWithWarnings(template, m.ext, JSON.parse(m.data), m.options);
}

port.on('message', (m: Request) => {
  handle(m).then(
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
