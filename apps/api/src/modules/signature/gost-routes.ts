import {
  GostCompleteBody,
  GostPrepareBody,
  IdParams,
  MAX_PDF_RESULT_BYTES,
  type CertificateInfo,
  type GostPrepareResult,
  type RunSignature,
} from '@carbone-reports/shared';
import * as asn1js from 'asn1js';
import { and, eq } from 'drizzle-orm';
import * as pkijs from 'pkijs';
import type { App } from '../../app';
import { gostSignPending, reportRunSignatures, reportRuns, type RunRow } from '../../db/schema';
import type { AppDeps } from '../../deps';
import { Deadline } from '../../lib/deadline';
import { badRequest, conflict, notFound } from '../../lib/errors';
import type { RunFileTx } from '../../lib/run-file-gate';
import { currentUser, type Guards } from '../auth/guards';
import type { GostHashAlg } from '../pdf/sign/gost/cades';
import { gostPublicKeyFromSpki } from '../pdf/sign/gost/gost3410';
import { certInfo } from '../pdf/sign/p12';
import { stampLines } from '../pdf/sign/sign-pdf';
import { runLocale } from '../reports/report-locale';
import {
  gostDraftPath,
  readSnapshotFile,
  RUN_FILE_LOCK_CLASS,
  signaturePath,
  signedPath,
  snapshotExt,
  snapshotGone,
  snapshotPaths,
  toRunSignature,
} from '../reports/snapshot';
import { busy, unavailable } from './sign-run';

/** Срок ожидания между подготовкой и завершением (§42.2). */
const PENDING_TTL_MS = 15 * 60 * 1000;
/** Открепленная подпись после декодирования — до 64 КБ (§42.2). */
const MAX_SIGNATURE_BYTES = 64 * 1024;
const OID_KEY_USAGE = '2.5.29.15';

const badCert = () => badRequest('gost.badCertificate');
const restart = () => conflict('gost.restart');

/** Подписываемый запуск ГОСТ (§42.2): свой, условия signable §39.3 и способ из снимка — 'gost'. */
type GostRun = RunRow & {
  filePath: string;
  signaturePosition: NonNullable<RunRow['signaturePosition']>;
};

async function loadGostRun(deps: AppDeps, runId: string, userId: string): Promise<GostRun> {
  const [run] = await deps.db.select().from(reportRuns).where(eq(reportRuns.id, runId));
  // Подписывает только владелец (§39.3): чужой запуск неотличим от несуществующего, и для администратора.
  if (!run || run.userId !== userId) throw notFound('run');
  if (
    !run.snapshot ||
    run.status !== 'ok' ||
    run.fileDeleted ||
    !run.filePath ||
    !run.signaturePosition ||
    run.signMethod !== 'gost'
  )
    throw unavailable();
  // Ранний ответ до проверки сертификата; решающая проверка — внутри блокировки (lockRun).
  const [done] = await deps.db
    .select({ runId: reportRunSignatures.runId })
    .from(reportRunSignatures)
    .where(eq(reportRunSignatures.runId, run.id));
  if (done) throw conflict('sign.alreadySigned');
  return run as GostRun;
}

/**
 * Внутри блокировки: строка запуска FOR SHARE (очистка ждёт конца подписи, §24.2) и проверка «уже подписан»
 * (одна подпись на запуск, R9).
 */
async function lockRun(tx: RunFileTx, runId: string): Promise<void> {
  const [cur] = await tx
    .select({ fileDeleted: reportRuns.fileDeleted })
    .from(reportRuns)
    .where(eq(reportRuns.id, runId))
    .for('share');
  if (!cur || cur.fileDeleted) throw snapshotGone();
  const [done] = await tx
    .select({ runId: reportRunSignatures.runId })
    .from(reportRunSignatures)
    .where(eq(reportRunSignatures.runId, runId));
  if (done) throw conflict('sign.alreadySigned');
}

/** `keyUsage` нет — подпись не запрещена; есть — нужен digitalSignature (§42.2). */
function allowsDigitalSignature(c: pkijs.Certificate): boolean {
  const ext = c.extensions?.find((e) => e.extnID === OID_KEY_USAGE);
  if (!ext) return true;
  const bits = (ext.parsedValue as asn1js.BitString | undefined)?.valueBlock.valueHexView;
  return ((bits?.[0] ?? 0) & 0x80) !== 0;
}

/** Проверки сертификата подготовки по порядку §42.2; первая неудача — 400 с её текстом. */
function checkCertificate(der: Buffer, now: Date): { info: CertificateInfo; hashAlg: GostHashAlg } {
  let cert: pkijs.Certificate;
  try {
    // Ровно один DER-объект без хвоста: этот же DER сравнивается с сертификатом в подписи (§42.4 п. 2).
    const asn = asn1js.fromBER(new Uint8Array(der));
    if (der.length === 0 || asn.offset !== der.length) throw new Error('хвост после сертификата');
    cert = new pkijs.Certificate({ schema: asn.result });
  } catch {
    throw badCert();
  }
  const key = gostPublicKeyFromSpki(new Uint8Array(cert.subjectPublicKeyInfo.toSchema().toBER()));
  if (!key) throw badRequest('gost.unsupportedCertificate');
  if (now < cert.notBefore.value) throw badRequest('sign.certNotYetValid');
  if (now > cert.notAfter.value) throw badRequest('sign.certExpired');
  if (!allowsDigitalSignature(cert)) throw badRequest('sign.certNotForSigning');
  let info: CertificateInfo;
  try {
    info = certInfo(der, `ГОСТ Р 34.10-2012 (${key.curve.bits})`);
  } catch {
    throw badCert();
  }
  return { info, hashAlg: key.curve.bits === 512 ? 'streebog512' : 'streebog256' };
}

/**
 * Подпись по ГОСТ через КриптоПро ЭЦП Browser plug-in (§42.2): подготовка (штамп и хеш черновика)
 * и завершение (проверка CAdES, подписанный PDF и `.sig`). PDF в браузер не передаётся.
 */
export function registerGostSignRoutes(app: App, deps: AppDeps, guards: Guards): void {
  const { storage, config } = deps;

  app.post(
    '/api/runs/:id/sign/gost/prepare',
    { preHandler: guards.requireUser, schema: { params: IdParams, body: GostPrepareBody } },
    async (req): Promise<GostPrepareResult> => {
      const deadline = new Deadline(config.reportTimeoutMs);
      const me = currentUser(req);
      const run = await loadGostRun(deps, req.params.id, me.id);
      const certDer = Buffer.from(req.body.certificate, 'base64');
      const { info, hashAlg } = checkCertificate(certDer, new Date());

      // Блокировка на пользователя без ожидания (§39.8, §42.2) — общая с подписью .p12 и завершением:
      // ожидание запуска меняет только его владелец, и все его подготовки и завершения идут по одной.
      const { hash, oldDraft } = await deps.runFileGate(
        RUN_FILE_LOCK_CLASS,
        `sign:${me.id}`,
        deadline,
        async (tx) => {
          await lockRun(tx, run.id);
          const [prev] = await tx
            .select({ draftPath: gostSignPending.draftPath })
            .from(gostSignPending)
            .where(eq(gostSignPending.runId, run.id));
          // Время штампа (§42.3) — время сервера при подготовке.
          const now = new Date();
          const pdf = await readSnapshotFile(
            deps,
            snapshotPaths(run.id, snapshotExt(run.filePath)).out('pdf'),
          );
          const prepared = await deps.gostPrepare(
            pdf,
            {
              position: run.signaturePosition,
              // Язык запуска, а не текущая настройка шаблона (§45.2).
              lines: stampLines(info, now, config.tz, runLocale(run)),
              hashAlg,
            },
            Date.now() + deadline.remaining(),
          );
          if (prepared.pdf.length > MAX_PDF_RESULT_BYTES)
            throw badRequest('pdf.resultTooLarge', { size: 100 });
          const draftPath = gostDraftPath(run.id);
          // Черновик пишется до строки: строка ожидания всегда указывает на записанный файл.
          // Путь у каждой подготовки свой: прежний черновик не трогается до фиксации новой строки
          // (сбой фиксации оставит прежнюю строку с её же черновиком), затем удаляется (oldDraft).
          const values = {
            userId: me.id,
            certDer,
            hash: Buffer.from(prepared.hash),
            hashAlg,
            draftPath,
            expiresAt: new Date(Date.now() + PENDING_TTL_MS),
          };
          try {
            await storage.write(draftPath, prepared.pdf);
            await tx
              .insert(gostSignPending)
              .values({ runId: run.id, ...values })
              .onConflictDoUpdate({ target: gostSignPending.runId, set: values });
          } catch (e) {
            // Новый черновик не нужен ни одной строке (откат) — не оставляем сироту.
            await storage
              .remove(draftPath)
              .catch((err) => req.log.warn({ err, runId: run.id }, 'черновик ГОСТ не удалён'));
            throw e;
          }
          return {
            hash: prepared.hash,
            oldDraft: prev && prev.draftPath !== draftPath ? prev.draftPath : null,
          };
        },
        { ifBusy: busy },
      );
      if (oldDraft)
        await storage
          .remove(oldDraft)
          .catch((err) => req.log.warn({ err, runId: run.id }, 'прежний черновик ГОСТ не удалён'));
      return { hash: Buffer.from(hash).toString('hex'), hashAlg, tsaUrl: config.signGostTsaUrl };
    },
  );

  app.post(
    '/api/runs/:id/sign/gost/complete',
    { preHandler: guards.requireUser, schema: { params: IdParams, body: GostCompleteBody } },
    async (req, reply) => {
      const deadline = new Deadline(config.reportTimeoutMs);
      const me = currentUser(req);
      const run = await loadGostRun(deps, req.params.id, me.id);
      const signature = Buffer.from(req.body.signature, 'base64');
      if (signature.length > MAX_SIGNATURE_BYTES) throw badRequest('gost.signatureTooLarge');
      const outcome = await deps.runFileGate(
        RUN_FILE_LOCK_CLASS,
        `sign:${me.id}`,
        deadline,
        async (
          tx,
        ): Promise<
          ({ signature: RunSignature } | { expired: true }) & { oldDraft: string | null }
        > => {
          await lockRun(tx, run.id);
          const [pending] = await tx
            .select()
            .from(gostSignPending)
            .where(and(eq(gostSignPending.runId, run.id), eq(gostSignPending.userId, me.id)));
          if (!pending) throw restart();
          const now = new Date();
          if (pending.expiresAt <= now) {
            // Удаление строки должно зафиксироваться — не бросаем из транзакции, а возвращаем результат.
            await tx.delete(gostSignPending).where(eq(gostSignPending.runId, run.id));
            return { expired: true, oldDraft: pending.draftPath };
          }
          // Любой отказ проверки — 400 GOST_INVALID; черновик и ожидание остаются до срока (§42.2).
          const result = await deps.gostVerify(
            {
              signature,
              certDer: pending.certDer,
              hash: pending.hash,
              hashAlg: pending.hashAlg,
              requireTimestamp: config.signGostTsaUrl !== null,
              now,
              // Время подготовки — нижняя граница времени метки (§42.4 п. 5).
              preparedAt: new Date(pending.expiresAt.getTime() - PENDING_TTL_MS),
            },
            Date.now() + deadline.remaining(),
          );
          let draft: Buffer;
          try {
            draft = await storage.read(pending.draftPath);
          } catch (e) {
            if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') throw e;
            // Черновика нет — ожидание бесполезно.
            await tx.delete(gostSignPending).where(eq(gostSignPending.runId, run.id));
            return { expired: true, oldDraft: null };
          }
          const pdfPath = signedPath(run.id);
          const sigPath = signaturePath(run.id);
          const info = certInfo(pending.certDer, '');
          let signed: RunSignature;
          try {
            await storage.write(pdfPath, draft);
            await storage.write(sigPath, signature);
            const [row] = await tx
              .insert(reportRunSignatures)
              .values({
                runId: run.id,
                userId: me.id,
                signerCn: info.subjectCn,
                fingerprint: info.fingerprint,
                // Время метки (её сертификат не проверяется, §42.4), без метки — время сервера.
                signedAt: result.signedAt ?? now,
                timestamped: result.timestamped,
                filePath: pdfPath,
                method: 'gost',
                sigPath,
              })
              .returning();
            await tx.delete(gostSignPending).where(eq(gostSignPending.runId, run.id));
            signed = toRunSignature(row!);
          } catch (e) {
            await Promise.all(
              [pdfPath, sigPath].map((p) =>
                storage
                  .remove(p)
                  .catch((err) => req.log.warn({ err, runId: run.id }, 'файл подписи не удалён')),
              ),
            );
            throw e;
          }
          return { signature: signed, oldDraft: pending.draftPath };
        },
        { ifBusy: busy },
      );
      // Черновик удалённой строки — только после фиксации (как oldDraft у подготовки): сбой фиксации
      // оставляет строку ожидания с её черновиком. Путь у каждой подготовки свой, новые его не займут.
      // Сбой удаления не мешает ответу — файл-сирота уйдёт с каталогом запуска.
      if (outcome.oldDraft)
        await storage
          .remove(outcome.oldDraft)
          .catch((err) => req.log.warn({ err, runId: run.id }, 'черновик ГОСТ не удалён'));
      if ('expired' in outcome) throw restart();
      return reply.status(201).send(outcome.signature);
    },
  );
}
