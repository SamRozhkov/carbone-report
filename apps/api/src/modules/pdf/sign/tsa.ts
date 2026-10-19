import { randomBytes } from 'node:crypto';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { AppError } from '../../../lib/errors';
import { OID } from './cms';

/** Метка времени RFC 3161 на SHA-256 значения подписи; возвращает DER TimeStampToken. */
export type TsaClient = (imprint: Uint8Array, deadline: number) => Promise<Uint8Array>;

export const tsaUnavailable = (cause?: unknown) =>
  new AppError('TSA_UNAVAILABLE', 502, 'служба меток времени недоступна', undefined, cause);
const timeout = () => new AppError('TIMEOUT', 504, 'превышено время ожидания');

const ab = (b: Uint8Array) => new Uint8Array(b).slice().buffer;
const same = (a: ArrayBuffer | Uint8Array, b: Uint8Array) =>
  Buffer.from(a as Uint8Array).equals(Buffer.from(b));

/** Ответ проверяется: статус granted/grantedWithMods, отпечаток и nonce совпадают (§39.4). */
function tokenFrom(body: Uint8Array, imprint: Uint8Array, nonce: Uint8Array): Uint8Array {
  const resp = pkijs.TimeStampResp.fromBER(ab(body));
  const status = resp.status.status;
  if ((status !== 0 && status !== 1) || !resp.timeStampToken)
    throw new Error(`статус ответа ${status}`);
  const signed = new pkijs.SignedData({ schema: resp.timeStampToken.content });
  const content = signed.encapContentInfo.eContent;
  if (!content) throw new Error('метка без TSTInfo');
  const tst = pkijs.TSTInfo.fromBER(content.getValue());
  if (!same(tst.messageImprint.hashedMessage.valueBlock.valueHexView, imprint))
    throw new Error('отпечаток метки не совпадает');
  if (!tst.nonce || !same(tst.nonce.valueBlock.valueHexView, nonce))
    throw new Error('nonce метки не совпадает');
  return new Uint8Array(resp.timeStampToken.toSchema().toBER());
}

export function createTsaClient(url: string, timeoutMs: number): TsaClient {
  return async (imprint, deadline) => {
    const left = deadline - Date.now();
    if (left <= 0) throw timeout();
    const byDeadline = left < timeoutMs;
    const nonce = randomBytes(8);
    // Положительное целое без ведущего нулевого байта: DER совпадёт с ответом байт в байт.
    nonce[0] = nonce[0]! & 0x7f || 1;
    const request = new pkijs.TimeStampReq({
      version: 1,
      messageImprint: new pkijs.MessageImprint({
        hashAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: OID.sha256 }),
        hashedMessage: new asn1js.OctetString({ valueHex: ab(imprint) }),
      }),
      nonce: new asn1js.Integer({ valueHex: ab(nonce) }),
      certReq: true,
    });
    let body: Uint8Array;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/timestamp-query' },
        body: Buffer.from(request.toSchema().toBER()),
        signal: AbortSignal.timeout(Math.min(left, timeoutMs)),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      body = new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      if (byDeadline && (e as Error).name === 'TimeoutError') throw timeout();
      throw tsaUnavailable(e);
    }
    try {
      return tokenFrom(body, imprint, nonce);
    } catch (e) {
      throw tsaUnavailable(e);
    }
  };
}
