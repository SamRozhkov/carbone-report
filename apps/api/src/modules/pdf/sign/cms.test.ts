import { createHash } from 'node:crypto';
import * as pkijs from 'pkijs';
import { describe, expect, it } from 'vitest';
import { buildSignedData, OID } from './cms';
import { fixture, FIXTURE_PASSWORD } from './fixtures';
import { readP12 } from './p12';

const ab = (b: Uint8Array) => new Uint8Array(b).slice().buffer;

async function signData(name: string, data: Buffer) {
  const p = readP12(fixture(name), FIXTURE_PASSWORD);
  const h = p.digestAlg === 'SHA-384' ? 'sha384' : 'sha256';
  const cms = await buildSignedData({
    key: p.key,
    cert: p.cert,
    chain: p.chain,
    digestAlg: p.digestAlg,
    digest: createHash(h).update(data).digest(),
  });
  return { p, sd: new pkijs.SignedData({ schema: pkijs.ContentInfo.fromBER(ab(cms)).content }) };
}

describe('buildSignedData (§39.4)', () => {
  it.each(['rsa.p12', 'ec.p12', 'ec384.p12', 'chain3.p12'])(
    '%s: подпись проверяется pkijs',
    async (name) => {
      const data = Buffer.from(`данные ${name}`);
      const { sd, p } = await signData(name, data);
      expect(await sd.verify({ signer: 0, data: ab(data), checkChain: false })).toBe(true);
      expect(sd.certificates).toHaveLength(1 + p.chain.length);
      expect(sd.encapContentInfo.eContent).toBeUndefined();
    },
  );

  it('подписанные атрибуты — ровно три, без signingTime', async () => {
    const { sd } = await signData('rsa.p12', Buffer.from('x'));
    const types = sd.signerInfos[0]!.signedAttrs!.attributes.map((a) => a.type);
    expect(types).toEqual([OID.contentType, OID.messageDigest, OID.signingCertV2]);
  });

  it('алгоритмы: RSA — sha256WithRSA, P-256 — ecdsa-with-SHA256, P-384 — SHA-384', async () => {
    const alg = async (n: string) => {
      const si = (await signData(n, Buffer.from('x'))).sd.signerInfos[0]!;
      return [si.digestAlgorithm.algorithmId, si.signatureAlgorithm.algorithmId];
    };
    expect(await alg('rsa.p12')).toEqual([OID.sha256, OID.sha256WithRsa]);
    expect(await alg('ec.p12')).toEqual([OID.sha256, OID.ecdsaWithSha256]);
    expect(await alg('ec384.p12')).toEqual([OID.sha384, OID.ecdsaWithSha384]);
  });
});
