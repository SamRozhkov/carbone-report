import { createHash } from 'node:crypto';
import type { CertificateInfo } from '@carbone-reports/shared';
import { buildSignedData, timestampAttribute } from './cms';
import type { DigestAlg, P12Contents } from './p12';
import type { TsaClient } from './tsa';

/** Запас /Contents сверх сертификатов: подпись, атрибуты и метка времени (§39.4). */
export const CMS_RESERVE_EXTRA = 12_288;

/**
 * Способ подписи (§39.4): в 2.9.0 — ключ из .p12; ГОСТ через КриптоПро DSS — будущая реализация.
 * Подготовка PDF и штамп от реализации не зависят.
 */
export interface CmsSigner {
  readonly info: CertificateInfo;
  readonly digestAlg: DigestAlg;
  /** Сколько байт может занять CMS (R4). */
  readonly reserveBytes: number;
  createCms(digest: Uint8Array, deadline: number): Promise<Uint8Array>;
}

export class P12Signer implements CmsSigner {
  readonly reserveBytes: number;

  constructor(
    private readonly p12: P12Contents,
    private readonly tsa: TsaClient | null,
  ) {
    this.reserveBytes =
      [p12.cert, ...p12.chain].reduce((n, c) => n + c.length, 0) + CMS_RESERVE_EXTRA;
  }

  get info(): CertificateInfo {
    return this.p12.info;
  }

  get digestAlg(): DigestAlg {
    return this.p12.digestAlg;
  }

  /** Подпись получит метку времени (настроена служба меток). */
  get timestamped(): boolean {
    return this.tsa !== null;
  }

  createCms(digest: Uint8Array, deadline: number): Promise<Uint8Array> {
    const tsa = this.tsa;
    return buildSignedData({
      key: this.p12.key,
      cert: this.p12.cert,
      chain: this.p12.chain,
      digestAlg: this.p12.digestAlg,
      digest,
      unsigned: tsa
        ? async (signature) => [
            timestampAttribute(
              await tsa(createHash('sha256').update(signature).digest(), deadline),
            ),
          ]
        : undefined,
    });
  }
}
