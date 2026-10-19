# Тестовые сертификаты подписи PDF

Только для тестов (§39.7). Пароль всех `.p12` — `test-password`; ключи `ca.key`, `tsa.key` — без пароля.
Пересоздать: `OPENSSL=<OpenSSL 3+> sh make.sh` (срок действия — 100 лет).

- `ca.pem` — тестовый УЦ (корень доверия в проверках pyHanko и `openssl cms -verify`);
- `rsa.p12` (OpenSSL 3: AES, MAC SHA-256), `rsa-legacy.p12` (`-legacy`: RC2/3DES, MAC SHA-1) — RSA-2048, serial 1001;
- `rsa-inn.p12` — RSA-2048 с ИНН (OID 1.2.643.3.131.1.1) в субъекте: обычный российский сертификат, не ГОСТ;
- `ec.p12` — ECDSA P-256; `ec384.p12` — ECDSA P-384; `rsa1024.p12` — слабый ключ;
- `nosign.p12` — `keyUsage` без подписи; `keyonly.p12` — ключ без сертификата; `nokey.p12` — сертификаты без ключа;
- `chain3.p12` — подписант, промежуточный УЦ и корень;
- `tsa.pem`, `tsa.key` — служба меток времени (`extendedKeyUsage=critical,timeStamping`).
