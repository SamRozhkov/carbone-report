// Поток пула рендера: собирает отчёт встроенной сборкой Carbone (формат шаблона), обрабатывает
// готовый PDF (§36.4, задача kind = pdf) или готовит PDF к подписи (§39.4, задача kind = sign)
// или разбирает .p12 (§39.8, задача kind = p12), ставит штамп и считает хеш Стрибог (§42, kind =
// gost-prepare) или проверяет подпись CAdES по ГОСТ (§42.4, kind = gost-verify).
// Глобальные carbone.set()/reset() не вызываем: lang, timezone и настройки загрузки изображений
// всегда приходят в options. Предупреждения рендера (R6) уходят пулу.
import { parentPort } from 'node:worker_threads';
import carbone from '@carbone-reports/carbone';
import { z } from 'zod';
import { postprocessPdf, type PdfPostJob } from '../pdf/postprocess';
import { CadesError, verifyCades, type GostHashAlg } from '../pdf/sign/gost/cades';
import { streebog } from '../pdf/sign/gost/streebog';
import { P12Error, readP12 } from '../pdf/sign/p12';
import {
  prepareSignaturePdf,
  prepareStampPdf,
  type SignPrepareJob,
  type StampJob,
} from '../pdf/sign/prepare';
import type { RenderOptions } from './pool';

interface Request {
  id: number;
  kind?: 'carbone' | 'pdf' | 'sign' | 'p12' | 'gost-prepare' | 'gost-verify';
  template: Uint8Array;
  ext: string;
  data: string;
  options: RenderOptions;
  extra?: Uint8Array[];
}

/** Данные задачи gost-verify (pool.ts → поток); времена — ISO-строки. */
const GostVerifyData = z.object({
  certDer: z.base64(),
  hash: z.hex(),
  hashAlg: z.enum(['streebog256', 'streebog512']),
  requireTimestamp: z.boolean(),
  now: z.iso.datetime(),
  preparedAt: z.iso.datetime().nullable(),
});

type PdfJobData = Omit<PdfPostJob, 'attachments'> & {
  attachments: { placement: PdfPostJob['attachments'][number]['placement'] }[];
};

const port = parentPort;
if (!port) throw new Error('worker.ts запускается только как поток пула рендера');

async function handle(
  m: Request,
): Promise<{ buffer: Uint8Array; warnings: string[]; meta?: string }> {
  const template = Buffer.from(m.template.buffer, m.template.byteOffset, m.template.byteLength);
  if (m.kind === 'p12') {
    const { password, now } = JSON.parse(m.data) as { password: string; now: string };
    const p = readP12(template, password, new Date(now));
    // Ключ — DER PKCS#8 без шифрования: главный поток делает из него KeyObject и затирает буфер.
    const key = p.key.export({ type: 'pkcs8', format: 'der' });
    const meta = JSON.stringify({
      cert: p.cert.toString('base64'),
      chain: p.chain.map((c) => c.toString('base64')),
      info: p.info,
      digestAlg: p.digestAlg,
    });
    return { buffer: key, warnings: [], meta };
  }
  if (m.kind === 'gost-prepare') {
    const job = JSON.parse(m.data) as StampJob & { hashAlg: GostHashAlg };
    const buffer = await prepareStampPdf(template, { position: job.position, lines: job.lines });
    const hash = streebog(job.hashAlg === 'streebog512' ? 512 : 256, buffer);
    return {
      buffer,
      warnings: [],
      meta: JSON.stringify({ hash: Buffer.from(hash).toString('hex') }),
    };
  }
  if (m.kind === 'gost-verify') {
    const d = GostVerifyData.parse(JSON.parse(m.data));
    const r = await verifyCades({
      signature: template,
      certDer: Buffer.from(d.certDer, 'base64'),
      hash: Buffer.from(d.hash, 'hex'),
      hashAlg: d.hashAlg,
      requireTimestamp: d.requireTimestamp,
      now: new Date(d.now),
      ...(d.preparedAt ? { preparedAt: new Date(d.preparedAt) } : {}),
    });
    const meta = JSON.stringify({
      signedAt: r.signedAt?.toISOString() ?? null,
      timestamped: r.timestamped,
    });
    return { buffer: new Uint8Array(0), warnings: [], meta };
  }
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
    ({ buffer: out, warnings, meta }) => {
      // Передаём ArrayBuffer без копии, если буфер занимает его целиком; иначе копируем.
      const ab = out.buffer;
      const whole =
        ab instanceof ArrayBuffer && out.byteOffset === 0 && out.byteLength === ab.byteLength;
      const bytes = whole ? new Uint8Array(ab, 0, out.byteLength) : new Uint8Array(out);
      port.postMessage({ id: m.id, ok: true, out: bytes, warnings, meta }, [
        bytes.buffer as ArrayBuffer,
      ]);
      // Копия (буфер не занимал ArrayBuffer целиком) осталась в потоке: для ключа затираем её.
      if (!whole && m.kind === 'p12') out.fill(0);
    },
    (err: unknown) => {
      port.postMessage({
        id: m.id,
        ok: false,
        message: err instanceof Error ? err.message : String(err),
        // P12Error: главный поток восстанавливает её с тем же полем (§39.8);
        // CadesError: отказ проверки ГОСТ, текст §42.4 — пользователю (поле gost).
        // key — ключ каталога errors: текст переводится на язык запроса в главном потоке.
        ...(err instanceof P12Error
          ? { field: err.field, key: err.key }
          : err instanceof CadesError
            ? { field: 'gost', key: err.key }
            : {}),
      });
    },
  );
});

// Модули загружены — пул может отдавать задачи.
port.postMessage({ ready: true });
