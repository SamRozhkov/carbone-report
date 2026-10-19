// Только для тестов: служба меток времени RFC 3161 на тестовом сертификате (fixtures/sign/tsa.*).
import { createHash, createPrivateKey } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';
import { buildSignedData, OID } from './cms';
import { fixture, fixtureCertDer } from './fixtures';

export type TestTsaMode = 'ok' | 'reject' | 'wrong-nonce' | 'wrong-imprint' | 'garbage' | 'hang';

export interface TestTsa {
  url: string;
  mode: TestTsaMode;
  requests: number;
  close(): Promise<void>;
}

const ab = (b: Uint8Array) => new Uint8Array(b).slice().buffer;

async function respond(body: Buffer, mode: TestTsaMode): Promise<Uint8Array> {
  if (mode === 'garbage') return Buffer.from('not a timestamp');
  if (mode === 'reject')
    return new Uint8Array(
      new pkijs.TimeStampResp({ status: new pkijs.PKIStatusInfo({ status: 2 }) })
        .toSchema()
        .toBER(),
    );
  const req = pkijs.TimeStampReq.fromBER(ab(body));
  const imprint = new Uint8Array(req.messageImprint.hashedMessage.valueBlock.valueHexView);
  if (mode === 'wrong-imprint') imprint[0] = imprint[0]! ^ 0xff;
  const nonce = new Uint8Array(req.nonce!.valueBlock.valueHexView);
  if (mode === 'wrong-nonce') nonce[nonce.length - 1] = nonce[nonce.length - 1]! ^ 0x01;
  const tst = new pkijs.TSTInfo({
    version: 1,
    policy: '1.2.3.4.1',
    messageImprint: new pkijs.MessageImprint({
      hashAlgorithm: req.messageImprint.hashAlgorithm,
      hashedMessage: new asn1js.OctetString({ valueHex: ab(imprint) }),
    }),
    serialNumber: new asn1js.Integer({ value: Date.now() % 1_000_000 }),
    genTime: new Date(),
    nonce: new asn1js.Integer({ valueHex: ab(nonce) }),
  });
  const tstDer = new Uint8Array(tst.toSchema().toBER());
  const token = await buildSignedData({
    key: createPrivateKey(fixture('tsa.key')),
    cert: fixtureCertDer('tsa.pem'),
    chain: [],
    digestAlg: 'SHA-256',
    digest: createHash('sha256').update(tstDer).digest(),
    contentType: OID.tstInfo,
    eContent: tstDer,
  });
  return new Uint8Array(
    new pkijs.TimeStampResp({
      status: new pkijs.PKIStatusInfo({ status: 0 }),
      timeStampToken: pkijs.ContentInfo.fromBER(ab(token)),
    })
      .toSchema()
      .toBER(),
  );
}

export async function startTestTsa(mode: TestTsaMode = 'ok'): Promise<TestTsa> {
  const tsa = { mode, requests: 0 } as TestTsa;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      tsa.requests++;
      if (tsa.mode === 'hang') return;
      respond(Buffer.concat(chunks), tsa.mode).then(
        (out) =>
          res
            .writeHead(200, { 'content-type': 'application/timestamp-reply' })
            .end(Buffer.from(out)),
        () => res.writeHead(500).end(),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  tsa.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/tsa`;
  tsa.close = () =>
    new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    });
  return tsa;
}
