[Русский](gost-signature.md) · **English**

# GOST signature (CryptoPro CAdES Browser plug-in)

Since 2.11.0, a report can be signed with a qualified or non-qualified signature under GOST R 34.10-2012.
The user's key never leaves their computer: the signature is created by the CryptoPro CAdES Browser plug-in in the browser,
and only the PDF hash and the finished signature are sent to the server. The result is two files: a stamped PDF and a detached
CAdES signature (`.sig`). A signature from a `.p12` file (PAdES, §39) works as before.

Enable it in the template: the "PDF" tab → "Electronic signature" → "Signing method" → "GOST, CryptoPro (.sig file)".
Everything works without server configuration (apart from the `cadesplugin_api.js` file).

## What the user's computer needs

- CryptoPro CSP 5.0 (the license is the organization's responsibility);
- the CryptoPro CAdES Browser plug-in and the browser extension;
- a GOST R 34.10-2012 certificate (256 or 512 bit) with the private key in the current user's "Personal" store.

Browsers: Chrome, Yandex Browser, Edge, Firefox (with the plug-in extension). Safari is not supported.
On the first signing, the plug-in asks for permission for the site; it also asks for the PIN or the container password.

## The cadesplugin_api.js script

The `cadesplugin_api.js` script is not included in the image: download it from the CryptoPro website after accepting the terms
(the distribution terms have not been confirmed, so we do not ship it). Without the file, the signing window
shows "CryptoPro CAdES Browser plug-in or CryptoPro CSP not found", while the server works as usual.

- **Docker Compose.** Put the file at `./cades/cadesplugin_api.js` next to `docker-compose.yml`. The directory is mounted into
  `web` as `/usr/share/nginx/cades` (read-only); no restart is needed. The file is not committed to git.
- **Helm.** Create a ConfigMap and specify its name:

  ```bash
  kubectl -n <namespace> create configmap cades --from-file=cadesplugin_api.js
  ```

  ```yaml
  web:
    cadesPluginConfigMap: cades
  ```

  The ConfigMap is mounted at `/usr/share/nginx/cades`; if empty (the default), there is no volume.

The file is served at `/cadesplugin_api.js` from our domain with the usual security headers.
If the file is missing, nginx responds with `404`, not `index.html`: otherwise the browser would receive HTML instead of a script.

## Timestamp service

`SIGN_GOST_TSA_URL` is an optional URL of an RFC 3161 timestamp service with GOST support (`http`/`https`;
an invalid URL prevents the API from starting). Empty — a signature without a timestamp (CAdES-BES); set — CAdES-T, and the timestamp is mandatory.
The service is contacted by the plug-in on the user's computer, so it must be reachable from there, not from the server.
In Helm it is `config.signGostTsaUrl`; in Docker, a variable in `.env`.

Timestamp restrictions the server enforces:

- a timestamp with a Streebog digest from an RSA/ECDSA service is rejected;
- a service with a GOST R 34.10-2001 key is rejected;
- several signature timestamp attributes in one signature are rejected;
- a CryptoPro TSP service with a 2012 key should work (expected; confirmed by manual acceptance).

## What the server verifies and what it does not

The server verifies the signature with its own GOST implementation (§42.4), in this order:

1. format: a detached signature, one signer;
2. the signer's certificate is the same as at preparation;
3. the hash algorithm is Streebog of the required length, and `messageDigest` equals the PDF hash;
4. the GOST R 34.10-2012 signature over the signed attributes is valid;
5. the timestamp (when a service is configured): the digest, the timestamp signature, the time within the certificate's validity period and
   not earlier than preparation (minus 5 minutes) and not later than the server time (plus 5 minutes) — the clocks of the timestamp service and
   the server must not differ by more than 5 minutes;
6. the certificate's validity period — at the timestamp time, otherwise at the server time.

The server does **not** verify the certificate chain up to a trusted root (the Ministry of Digital Development and others), revocation lists (CRL/OCSP),
or the timestamp service's certificate. The time from the timestamp is informational, not trusted. The authenticity of the certificate is confirmed
by a verification service: Gosuslugi verifies the chain.

The plug-in includes only the signer's certificate in the signature (`CAPICOM_CERTIFICATE_INCLUDE_END_ENTITY_ONLY`),
so signing does not require an installed chain. If a chain error (`0x800B010A`) still appears,
check the certificate in CryptoPro (`CheckCertificate`).

## Verifying the signature on Gosuslugi

Download "PDF with stamp" and "Signature (.sig)" from the report and upload the pair to
[gosuslugi.ru/pgu/eds](https://www.gosuslugi.ru/pgu/eds) (detached signature: the file and the signature separately).
The test certification authority's certificate will be shown as "not trusted" — this is expected.

## Hash byte order

The server returns `hash` in hex, and the plug-in receives it in `SetHashValue` in the same byte order, only in upper
case: this is the byte order of `messageDigest` in CMS. Compatibility is confirmed by manual acceptance with the real plug-in. If the server rejected
a signature from the real plug-in, save the `.sig` file and the `hash` field from the prepare response (`POST /api/runs/:id/sign/gost/prepare`)
for analysis: the byte order is the first suspect.

## Content Security Policy (CSP)

The page serves `script-src 'self'`, while `cadesplugin_api.js` makes the extension inject its own script into the page.
According to the Chromium documentation, the page CSP does not block extension scripts (Chrome, Edge) — verify this during acceptance;
in Firefox and Yandex Browser the behavior is also checked by manual acceptance.
The CSP is not relaxed.

## Signature draft

Each preparation writes the PDF draft to a unique file `reports/<id>/out.gost.<uuid>.pdf`, not to `out.gost.pdf`:
this way a failed completion cannot associate an old hash with a new draft. Expired pending requests (15 minutes) and drafts
are removed by the hourly cleanup.

## Upgrade

Migration `0014` is applied automatically. If GOST signing is not needed, nothing has to be done.
