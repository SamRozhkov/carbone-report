#!/usr/bin/env node
// CAdES-T для тестовых данных ГОСТ (§42): добавляет токен метки времени в неподписанный атрибут
// signature-time-stamp (1.2.840.113549.1.9.16.2.14) первого SignerInfo подписи CAdES-BES.
// Использование: node scripts/gost-fixtures-cades-t.mjs <bes.sig> <token.der> <out.sig>
// Вызывается из scripts/gost-fixtures.sh; pkijs и asn1js берутся из apps/api.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const asn1js = require('asn1js');
const pkijs = require('pkijs');

const ID_SIGNATURE_TIME_STAMP = '1.2.840.113549.1.9.16.2.14';
const ID_SIGNED_DATA = '1.2.840.113549.1.7.2';

/** DER-разбор с проверкой, что разобран весь буфер. */
function parse(buf, what) {
  const view = new Uint8Array(buf);
  const res = asn1js.fromBER(view);
  if (res.offset === -1 || res.offset !== view.byteLength)
    throw new Error(`${what}: некорректный DER`);
  return res.result;
}

function main([sigPath, tokenPath, outPath]) {
  if (!sigPath || !tokenPath || !outPath) {
    console.error('Использование: gost-fixtures-cades-t.mjs <bes.sig> <token.der> <out.sig>');
    process.exit(2);
  }
  const ci = new pkijs.ContentInfo({ schema: parse(readFileSync(sigPath), sigPath) });
  if (ci.contentType !== ID_SIGNED_DATA) throw new Error(`${sigPath}: не SignedData`);
  const sd = new pkijs.SignedData({ schema: ci.content });
  const si = sd.signerInfos[0];
  const token = parse(readFileSync(tokenPath), tokenPath);
  si.unsignedAttrs = new pkijs.SignedAndUnsignedAttributes({
    type: 1,
    attributes: [new pkijs.Attribute({ type: ID_SIGNATURE_TIME_STAMP, values: [token] })],
  });
  const out = new pkijs.ContentInfo({ contentType: ID_SIGNED_DATA, content: sd.toSchema(true) });
  writeFileSync(outPath, new Uint8Array(out.toSchema().toBER(false)));
}

main(process.argv.slice(2));
