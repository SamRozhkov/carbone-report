import {
  IdParams,
  MAX_PDF_RESULT_BYTES,
  SignRunBody,
  type RunSignature,
} from '@carbone-reports/shared';
import { eq } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import type { App } from '../../app';
import { reportRunSignatures, reportRuns } from '../../db/schema';
import type { AppDeps } from '../../deps';
import { decryptSecret } from '../../lib/crypto';
import { Deadline } from '../../lib/deadline';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors';
import { currentUser, type Guards } from '../auth/guards';
import { P12Error, readP12, type P12Contents } from '../pdf/sign/p12';
import { signPdf } from '../pdf/sign/sign-pdf';
import { P12Signer } from '../pdf/sign/signer';
import { createTsaClient } from '../pdf/sign/tsa';
import {
  readSnapshotFile,
  RUN_FILE_LOCK_CLASS,
  signedPath,
  snapshotExt,
  snapshotGone,
  snapshotPaths,
  toRunSignature,
} from '../reports/snapshot';
import { loadUserCertificate } from './certificates';

const unavailable = () => badRequest('подпись для этого отчёта недоступна');
// Пароль не попадает ни в сообщение, ни в details (Review Focus 1).
const wrongPassword = () =>
  new AppError('VALIDATION', 400, 'неверные данные запроса', [
    { path: '/password', message: 'неверный пароль к ключу' },
  ]);
const tooMany = () =>
  new AppError(
    'TOO_MANY_ATTEMPTS',
    429,
    'слишком много неверных паролей — попробуйте через 15 минут',
  );

/** POST /api/runs/:id/sign — подпись PDF запуска сертификатом пользователя (§39.3). */
export function registerSignRunRoute(app: App, deps: AppDeps, guards: Guards): void {
  const { db, storage, config } = deps;
  // R8: считаются только неверные пароли. createRateLimit 11.2: `{ increment: false }` читает счётчик
  // (store.read) и даёт remaining = max(0, max - current), т. е. 0 после пяти неверных.
  // В типах CreateRateLimitOptions нет nameSpace (его читает FallbackStore.child) — опции через переменную.
  const limitOptions = {
    max: 5,
    timeWindow: '15 minutes',
    nameSpace: 'cr:rl-sign:',
    keyGenerator: (req: FastifyRequest) => currentUser(req).id,
  };
  const limit = app.createRateLimit(limitOptions);
  const assertAttemptsLeft = async (req: FastifyRequest) => {
    const attempts = await limit(req, { increment: false });
    // isAllowed: true — только для allowList (не задан); иначе remaining — сколько неверных осталось.
    if (!attempts.isAllowed && attempts.remaining <= 0) throw tooMany();
  };

  app.post(
    '/api/runs/:id/sign',
    { preHandler: guards.requireUser, schema: { params: IdParams, body: SignRunBody } },
    async (req, reply) => {
      const deadline = new Deadline(config.reportTimeoutMs);
      const me = currentUser(req);
      const [run] = await db.select().from(reportRuns).where(eq(reportRuns.id, req.params.id));
      // Подписывает только владелец (§39.3): чужой запуск неотличим от несуществующего, и для администратора.
      if (!run || run.userId !== me.id) throw notFound('запуск');
      const position = run.signaturePosition;
      const filePath = run.filePath;
      if (!run.snapshot || run.status !== 'ok' || run.fileDeleted || !filePath || !position)
        throw unavailable();
      const cert = await loadUserCertificate(db, me.id);
      if (!cert) throw badRequest('загрузите сертификат на странице «Моя подпись»');
      const checkedAt = new Date();
      if (checkedAt < cert.notBefore) throw badRequest('сертификат ещё не действует');
      if (checkedAt > cert.notAfter) throw badRequest('срок действия сертификата истёк');
      // Ранний 429 без ожидания блокировки; решающая проверка — внутри неё, перед паролем.
      await assertAttemptsLeft(req);

      // Блокировка на пользователя, а не на запуск: все попытки подписи одного пользователя (на любых
      // запусках и экземплярах API) идут по одной, поэтому каждая видит счётчик неверных паролей с учётом
      // предыдущих — одновременные запросы не дают больше пяти попыток (R8). Подписывает только владелец,
      // так что одна подпись на запуск (R9) соблюдается: проверка «уже подписан» — внутри блокировки.
      const result: RunSignature = await deps.runFileGate(
        RUN_FILE_LOCK_CLASS,
        `sign:${me.id}`,
        deadline,
        async (tx) => {
          // FOR SHARE: очистка ждёт конца подписи (как сборка форматов, §24.2).
          const [cur] = await tx
            .select({ fileDeleted: reportRuns.fileDeleted })
            .from(reportRuns)
            .where(eq(reportRuns.id, run.id))
            .for('share');
          if (!cur || cur.fileDeleted) throw snapshotGone();
          const [done] = await tx
            .select({ runId: reportRunSignatures.runId })
            .from(reportRunSignatures)
            .where(eq(reportRunSignatures.runId, run.id));
          if (done) throw conflict('отчёт уже подписан');

          await assertAttemptsLeft(req);
          // Время подписи — после ожидания блокировки: им проверяется срок сертификата (readP12),
          // оно же в штампе, /M и строке подписи.
          const now = new Date();
          let p12: P12Contents;
          try {
            p12 = readP12(
              Buffer.from(decryptSecret(cert.p12Enc, config.encryptionKey), 'base64'),
              req.body.password,
              now,
            );
          } catch (e) {
            if (e instanceof P12Error && e.field === 'password') {
              await limit(req);
              throw wrongPassword();
            }
            if (e instanceof P12Error) throw badRequest(e.message);
            throw e;
          }
          const signer = new P12Signer(
            p12,
            config.signTsaUrl ? createTsaClient(config.signTsaUrl, config.signTsaTimeoutMs) : null,
          );
          const pdf = await readSnapshotFile(
            deps,
            snapshotPaths(run.id, snapshotExt(filePath)).out('pdf'),
          );
          const signed = await signPdf(pdf, signer, {
            position,
            now,
            timeZone: config.tz,
            deadline: Date.now() + deadline.remaining(),
            prepare: deps.pdfSignPrepare,
          });
          if (signed.length > MAX_PDF_RESULT_BYTES) throw badRequest('итоговый PDF больше 100 МБ');
          const path = signedPath(run.id);
          await storage.write(path, signed);
          try {
            const [row] = await tx
              .insert(reportRunSignatures)
              .values({
                runId: run.id,
                userId: me.id,
                signerCn: p12.info.subjectCn,
                fingerprint: p12.info.fingerprint,
                signedAt: now,
                timestamped: signer.timestamped,
                filePath: path,
              })
              .returning();
            return toRunSignature(row!);
          } catch (e) {
            await storage
              .remove(path)
              .catch((err) => req.log.warn({ err, runId: run.id }, 'подписанный файл не удалён'));
            throw e;
          }
        },
      );
      return reply.status(201).send(result);
    },
  );
}
