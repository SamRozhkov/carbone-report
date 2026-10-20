import { createPrivateKey } from 'node:crypto';
import type { CertificateInfo } from '@carbone-reports/shared';
import type { P12Reader } from '../../../deps';
import { AppError } from '../../../lib/errors';
import { RenderTimeoutError, TemplateRenderError, type RenderPool } from '../../render/pool';
import { P12Error, readP12, type DigestAlg } from './p12';

interface P12Meta {
  cert: string;
  chain: string[];
  info: CertificateInfo;
  digestAlg: DigestAlg;
}

/** Разбор — задачей пула рендера: KDF (до 300 000 итераций) не блокирует главный поток (§39.8). */
export function createPoolP12Reader(pool: Pick<RenderPool, 'run'>): P12Reader {
  return async (file, password, now, deadlineAt) => {
    let r;
    try {
      r = await pool.run(
        {
          kind: 'p12',
          template: file,
          ext: 'p12',
          data: { password, now: now.toISOString() },
          options: { lang: '', timezone: '' },
        },
        deadlineAt,
      );
    } catch (e) {
      if (e instanceof RenderTimeoutError)
        throw new AppError('TIMEOUT', 504, 'превышено время ожидания');
      if (e instanceof TemplateRenderError && (e.field === 'file' || e.field === 'password'))
        throw new P12Error(e.field, e.message);
      // Прочее — внутренняя ошибка; текст потока пользователю не нужен.
      throw new Error('разбор .p12 в пуле рендера не удался', { cause: e });
    }
    const meta = r.meta as P12Meta;
    try {
      return {
        key: createPrivateKey({ key: r.out, format: 'der', type: 'pkcs8' }),
        cert: Buffer.from(meta.cert, 'base64'),
        chain: meta.chain.map((c) => Buffer.from(c, 'base64')),
        info: meta.info,
        digestAlg: meta.digestAlg,
      };
    } finally {
      r.out.fill(0);
    }
  };
}

/** В этом потоке — для тестов API (createTestApp). */
export const inProcessP12Reader: P12Reader = async (file, password, now) =>
  readP12(file, password, now);
