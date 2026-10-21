# Тестовые данные подписи по ГОСТ (§42)

Все ключи — тестовые, без пароля, нигде больше не используются; это не секреты.

Пересоздать (нужны Docker и Node 22; образ `rnix/openssl-gost` — OpenSSL 1.1.1 с движком gost —
скачивается и удаляется в конце):

```sh
sh scripts/gost-fixtures.sh
```

Подписи ГОСТ рандомизированы, поэтому после пересоздания меняются все `.sig`, `.bin`, ключи и
сертификаты; `doc.pdf` и его хеши остаются прежними. Скрипт сам проверяет каждую корректную подпись
через `openssl cms -verify` и падает, если `bad-hash.sig` или `bad-value.sig` проходят проверку.

## Ключи и сертификаты

Срок — 20 лет. Все сертификаты выданы `ca.pem`. Пользователи и `expired256`:
`keyUsage = critical, digitalSignature, nonRepudiation`.

| Файлы                 | Что                                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------------------- |
| `ca.pem`, `ca.key`    | Самоподписанный УЦ, ГОСТ Р 34.10-2012 256 бит, `id-tc26-gost-3410-2012-256-paramSetA`                     |
| `user256a.pem/.key`   | Пользователь, 256 бит, `id-tc26-gost-3410-2012-256-paramSetA` (в движке — `paramset:TCA`)                 |
| `user256cp.pem/.key`  | Пользователь, 256 бит, `id-GostR3410-2001-CryptoPro-A-ParamSet` (в движке — `paramset:A`)                 |
| `user512a.pem/.key`   | Пользователь, 512 бит, `id-tc26-gost-3410-2012-512-paramSetA` (`gost2012_512`, `paramset:A`)              |
| `other256.pem/.key`   | Второй пользователь (Петров), 256 бит, tc26 A                                                             |
| `expired256.pem/.key` | Срок истёк: 2020-01-01 — 2021-01-01 (выпущен `openssl ca -startdate/-enddate`)                            |
| `nosign256.pem/.key`  | `keyUsage = critical, keyEncipherment` — не для подписи                                                   |
| `tsa.pem/.key`        | Служба меток времени, ГОСТ 2012-256 (tc26 A), `extendedKeyUsage = critical, timeStamping`                 |
| `tsa-rsa.pem/.key`    | Служба меток времени, RSA 2048 (сертификат подписан ГОСТ-УЦ), `extendedKeyUsage = critical, timeStamping` |

## Документ и хеши

| Файл                      | Что                                                                        |
| ------------------------- | -------------------------------------------------------------------------- |
| `doc.pdf`                 | Небольшой корректный PDF (одна пустая страница, 329 байт)                  |
| `doc.pdf.streebog256.hex` | `openssl dgst -md_gost12_256 doc.pdf` (строка `md_gost12_256(doc.pdf)= …`) |
| `doc.pdf.streebog512.hex` | `openssl dgst -md_gost12_512 doc.pdf`                                      |

Хеш пустого сообщения (`printf '' | openssl dgst …`, записан в `streebog.test.ts`):

- 256: `3f539a213e97c802cc229d474c6aa32a825a360b2a933a949fd925208d9ce1bb`
- 512: `8e945da209aa869f0455928529bcae4679e9873ab707b55315f56ceb98bef0a7362f715528356ee83cda5f2aac4c6ad2ba3a715c1bcd81cb8e9f90bf4c1c1a8a`

## Подписи

Все — CMS SignedData в DER, `openssl cms -sign -binary`, по умолчанию открепленные; подписанные
атрибуты OpenSSL по умолчанию: `contentType`, `signingTime`, `messageDigest`, `smimeCapabilities`.
Сертификат подписанта вложен. Атрибута `signingCertificateV2` нет: в OpenSSL 1.1.1 нет `-cades`.

| Файл                 | Что                                                                                           |
| -------------------- | --------------------------------------------------------------------------------------------- |
| `bes-256a.sig`       | `user256a`, Стрибог-256, над `doc.pdf`                                                        |
| `bes-256cp.sig`      | `user256cp`, Стрибог-256                                                                      |
| `bes-512a.sig`       | `user512a`, Стрибог-512                                                                       |
| `bes-256a-chain.sig` | `user256a` + `-certfile ca.pem` (цепочка в `certificates`), `signingTime` есть                |
| `bes-256a-other.sig` | `other256` над `doc.pdf`                                                                      |
| `no-attrs.sig`       | `user256a`, `-noattr`: без подписанных атрибутов                                              |
| `with-content.sig`   | `user256a`, `-nodetach`: `doc.pdf` внутри подписи                                             |
| `bad-hash.sig`       | `user256a` над другим текстом — с `doc.pdf` не сходится `messageDigest`                       |
| `bad-value.sig`      | `bes-256a.sig` с испорченным последним байтом (xor 1) — это байт значения подписи             |
| `t-256a.sig`         | CAdES-T: `bes-256a.sig` + неподписанный атрибут `1.2.840.113549.1.9.16.2.14`, метка `tsa`     |
| `t-256a-rsa.sig`     | То же, метка `tsa-rsa`: подпись RSA/SHA-256, imprint — SHA-256 значения подписи               |
| `raw-256a.bin`       | `openssl pkeyutl -sign -inkey user256a.key` над `openssl dgst -md_gost12_256 -binary doc.pdf` |
| `raw-512a.bin`       | То же, `user512a.key` и Стрибог-512                                                           |

Метка `t-256a.sig`: imprint — Стрибог-256 от значения подписи (`SignerInfo.signature`, последние
64 байта `bes-256a.sig`), подпись службы — ГОСТ 2012-256/Стрибог-256; обе метки с `ESSCertIDv2`
(SHA-256), без nonce. В `openssl ts` нет готовой команды CAdES-T, поэтому токен (`ts -reply
-token_out`) вставляет в `SignerInfo` скрипт `scripts/gost-fixtures-cades-t.mjs` (pkijs);
подписанная часть при этом не меняется (`openssl cms -verify` проходит).

`raw-*.bin` — подпись в формате движка gost (64/128 байт), как ее выдает `pkeyutl`; на вход
подаются байты хеша в порядке `openssl dgst -binary`. Скрипт проверяет их `pkeyutl -verify`.
