import { IdParams, type CertificateInfo, type MyCertificate } from '@carbone-reports/shared';
import { eq } from 'drizzle-orm';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { App } from '../../app';
import { userCertificates, users } from '../../db/schema';
import type { AppDeps } from '../../deps';
import { encryptSecret } from '../../lib/crypto';
import { AppError, badRequest, notFound } from '../../lib/errors';
import { currentUser, type Guards } from '../auth/guards';
import { P12Error } from '../pdf/sign/p12';
import { loadUserCertificate, p12FieldError, toCertificateInfo } from './certificates';
import { registerGostSignRoutes } from './gost-routes';
import { registerSignRunRoute } from './sign-run';

/** Чтение формы загрузки: лимит части — 1 МБ (сообщение о 50 КБ даёт readP12, а не плагин). */
async function readCertificateUpload(
  req: FastifyRequest,
): Promise<{ file: Buffer; password: string }> {
  let file: Buffer | undefined;
  let password: string | undefined;
  try {
    for await (const part of req.parts({ limits: { fileSize: 1024 * 1024 } })) {
      if (part.type === 'file') {
        if (part.fieldname !== 'file') throw badRequest('файл передаётся в поле file');
        file = await part.toBuffer();
      } else if (part.fieldname === 'password') password = String(part.value);
    }
  } catch (err) {
    // Больше 1 МБ — не общее «файл больше 20 МБ» (413), а то же, что даёт readP12 (400 у /file).
    if ((err as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE')
      throw p12FieldError(new P12Error('file', 'файл больше 50 КБ'));
    throw err;
  }
  if (!file) throw badRequest('файл не передан');
  if (!password)
    throw new AppError('VALIDATION', 400, 'неверные данные запроса', [
      { path: '/password', message: 'укажите пароль' },
    ]);
  return { file, password };
}

export function registerSignatureRoutes(app: App, deps: AppDeps, guards: Guards): void {
  const { db } = deps;
  registerSignRunRoute(app, deps, guards);
  registerGostSignRoutes(app, deps, guards);

  app.get(
    '/api/me/certificate',
    { preHandler: guards.requireUser },
    async (req): Promise<MyCertificate> => {
      const row = await loadUserCertificate(db, currentUser(req).id);
      return { certificate: row ? toCertificateInfo(row) : null };
    },
  );

  // Каждая загрузка — разбор .p12 в пуле рендера (до 300 000 итераций KDF): не больше 10 в минуту
  // на пользователя, чтобы не занимать пул. Лимит — в preHandler после входа, до чтения тела (multipart читает обработчик).
  // В типах CreateRateLimitOptions нет nameSpace (его читает FallbackStore.child) — опции через переменную.
  const uploadLimitOptions = {
    max: 10,
    timeWindow: '1 minute',
    nameSpace: 'cr:rl-cert:',
    keyGenerator: (req: FastifyRequest) => currentUser(req).id,
  };
  const uploadLimit = app.createRateLimit(uploadLimitOptions);
  const limitUploads = async (req: FastifyRequest, reply: FastifyReply) => {
    const r = await uploadLimit(req);
    if (!r.isAllowed && r.isExceeded) {
      reply
        .header('retry-after', r.ttlInSeconds)
        .header('x-ratelimit-limit', r.max)
        .header('x-ratelimit-remaining', 0);
      throw new AppError(
        'TOO_MANY_ATTEMPTS',
        429,
        'слишком много загрузок сертификата — попробуйте через минуту',
      );
    }
  };

  app.post(
    '/api/me/certificate',
    { preHandler: [guards.requireUser, limitUploads] },
    async (req, reply) => {
      // Срок отсчитывается от начала запроса, а не от конца чтения тела.
      const deadlineAt = Date.now() + deps.config.reportTimeoutMs;
      const { file, password } = await readCertificateUpload(req);
      let info: CertificateInfo;
      try {
        info = (await deps.p12Read(file, password, new Date(), deadlineAt)).info;
      } catch (e) {
        if (e instanceof P12Error) throw p12FieldError(e);
        throw e;
      }
      const values = {
        p12Enc: encryptSecret(file.toString('base64'), deps.config.encryptionKey),
        subjectCn: info.subjectCn,
        issuer: info.issuer,
        serial: info.serial,
        fingerprint: info.fingerprint,
        keyAlg: info.keyAlg,
        notBefore: new Date(info.notBefore),
        notAfter: new Date(info.notAfter),
      };
      await db
        .insert(userCertificates)
        .values({ userId: currentUser(req).id, ...values })
        .onConflictDoUpdate({
          target: userCertificates.userId,
          set: { ...values, createdAt: new Date() },
        });
      return reply.status(201).send(info);
    },
  );

  app.delete('/api/me/certificate', { preHandler: guards.requireUser }, async (req, reply) => {
    await db.delete(userCertificates).where(eq(userCertificates.userId, currentUser(req).id));
    return reply.status(204).send();
  });

  app.delete(
    '/api/users/:id/certificate',
    { preHandler: guards.requireAdmin, schema: { params: IdParams } },
    async (req, reply) => {
      const [user] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.id, req.params.id));
      if (!user) throw notFound('пользователь');
      await db.delete(userCertificates).where(eq(userCertificates.userId, user.id));
      return reply.status(204).send();
    },
  );
}
