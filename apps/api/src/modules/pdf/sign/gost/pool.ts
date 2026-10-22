import { z } from 'zod';
import type { GostPreparer, GostVerifier } from '../../../../deps';
import { AppError } from '../../../../lib/errors';
import { RenderTimeoutError, TemplateRenderError, type RenderPool } from '../../../render/pool';
import { prepareStampPdf } from '../prepare';
import { CadesError, verifyCades, type GostHashAlg } from './cades';
import { streebog } from './streebog';

const HEX_LEN: Record<GostHashAlg, number> = { streebog256: 64, streebog512: 128 };
const bits = (alg: GostHashAlg) => (alg === 'streebog512' ? 512 : 256);

/** Ответы потока проверяются: чужая или повреждённая форма не должна дойти до маршрута как TypeError. */
const PrepareMeta = z.object({ hash: z.string().regex(/^[0-9a-f]+$/) });
const VerifyMeta = z.object({
  signedAt: z.iso.datetime().nullable(),
  timestamped: z.boolean(),
});

const timeout = () => new AppError('TIMEOUT', 504, { key: 'timeout' });
const invalid = (key: string) => new AppError('GOST_INVALID', 400, { key });

/** Штамп без поля подписи и хеш Стрибог — задачей пула рендера: pdf-lib не блокирует главный поток (§42). */
export function createPoolGostPreparer(pool: Pick<RenderPool, 'run'>): GostPreparer {
  return async (pdf, job, deadlineAt) => {
    let r;
    try {
      r = await pool.run(
        {
          kind: 'gost-prepare',
          template: pdf,
          ext: 'pdf',
          data: { position: job.position, lines: job.lines, hashAlg: job.hashAlg },
          options: { lang: '', timezone: '' },
        },
        deadlineAt,
      );
    } catch (e) {
      if (e instanceof RenderTimeoutError) throw timeout();
      // Прочее — внутренняя ошибка; текст потока пользователю не нужен.
      throw new Error('подготовка PDF ГОСТ в пуле рендера не удалась', { cause: e });
    }
    const parsed = PrepareMeta.safeParse(r.meta);
    if (!parsed.success || parsed.data.hash.length !== HEX_LEN[job.hashAlg])
      throw new Error('некорректный ответ потока при подготовке PDF ГОСТ');
    return { pdf: r.out, hash: Buffer.from(parsed.data.hash, 'hex') };
  };
}

/** Проверка подписи CAdES — задачей пула рендера: арифметика ГОСТ не блокирует главный поток (§42.4). */
export function createPoolGostVerifier(pool: Pick<RenderPool, 'run'>): GostVerifier {
  return async (input, deadlineAt) => {
    let r;
    try {
      r = await pool.run(
        {
          kind: 'gost-verify',
          template: Buffer.from(input.signature),
          ext: 'sig',
          data: {
            certDer: Buffer.from(input.certDer).toString('base64'),
            hash: Buffer.from(input.hash).toString('hex'),
            hashAlg: input.hashAlg,
            requireTimestamp: input.requireTimestamp,
            now: input.now.toISOString(),
            preparedAt: input.preparedAt?.toISOString() ?? null,
          },
          options: { lang: '', timezone: '' },
        },
        deadlineAt,
      );
    } catch (e) {
      if (e instanceof RenderTimeoutError) throw timeout();
      if (e instanceof TemplateRenderError && e.field === 'gost')
        throw invalid(e.text?.key ?? 'gost.invalid');
      throw new Error('проверка подписи ГОСТ в пуле рендера не удалась', { cause: e });
    }
    const parsed = VerifyMeta.safeParse(r.meta);
    if (!parsed.success) throw new Error('некорректный ответ потока при проверке подписи ГОСТ');
    const { signedAt, timestamped } = parsed.data;
    return { signedAt: signedAt === null ? null : new Date(signedAt), timestamped };
  };
}

/** В этом потоке — для тестов API (createTestApp). */
export const inProcessGostPreparer: GostPreparer = async (pdf, job) => {
  const out = Buffer.from(await prepareStampPdf(pdf, { position: job.position, lines: job.lines }));
  return { pdf: out, hash: streebog(bits(job.hashAlg), out) };
};

/** В этом потоке — для тестов API (createTestApp). */
export const inProcessGostVerifier: GostVerifier = async (input) => {
  try {
    return await verifyCades(input);
  } catch (e) {
    if (e instanceof CadesError) throw invalid(e.key);
    throw e;
  }
};
