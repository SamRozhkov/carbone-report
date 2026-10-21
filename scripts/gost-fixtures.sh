#!/bin/sh
# Тестовые данные подписи по ГОСТ (§42): ключи и сертификаты ГОСТ Р 34.10-2012, подписи CAdES,
# метки времени. Ключи тестовые, не секреты. Нужны Docker и Node 22 (pkijs из apps/api).
# OpenSSL с движком gost — в образе rnix/openssl-gost (OpenSSL 1.1.1); образ удаляется в конце.
# Запуск из корня репозитория: sh scripts/gost-fixtures.sh
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT="$ROOT/apps/api/test/fixtures/gost"
IMAGE=rnix/openssl-gost
mkdir -p "$OUT"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# gost <скрипт sh из stdin>: выполнить в контейнере; /out — фикстуры, /w — временная папка.
gost() {
  docker run --rm -i --platform linux/amd64 -v "$OUT:/out" -v "$WORK:/w" -w /out "$IMAGE" sh -s
}

# Шаг 1: ключи, сертификаты, подписи, запросы и ответы меток времени.
gost <<'EOF'
set -eu
DAYS=7300
W=/w
# Разделы для `openssl ca` и `openssl ts` поверх конфигурации образа. Движок gost уже подключен
# конфигурацией по умолчанию; повторное подключение через -config падает, поэтому без openssl_conf.
grep -v '^openssl_conf' /usr/local/ssl/openssl.cnf >$W/cnf
cat >>$W/cnf <<'CNF'
[ ca_expired ]
dir = /w/ca
database = $dir/index.txt
new_certs_dir = $dir
serial = $dir/serial
default_md = md_gost12_256
policy = policy_anything
unique_subject = no
[ tsa ]
default_tsa = tsa_gost
[ tsa_gost ]
serial = /w/tsaserial
crypto_device = builtin
signer_digest = md_gost12_256
default_policy = 1.2.3.4.1
digests = md_gost12_256, sha256
accuracy = secs:1
ordering = no
tsa_name = no
ess_cert_id_chain = no
ess_cert_id_alg = sha256
[ tsa_rsa ]
serial = /w/tsaserial
crypto_device = builtin
signer_digest = sha256
default_policy = 1.2.3.4.1
digests = md_gost12_256, sha256
accuracy = secs:1
ordering = no
tsa_name = no
ess_cert_id_chain = no
ess_cert_id_alg = sha256
CNF
mkdir -p $W/ca && : >$W/ca/index.txt && echo 3001 >$W/ca/serial && echo 4001 >$W/tsaserial
printf 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n' >$W/ca.ext
printf 'basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,nonRepudiation\n' >$W/sign.ext
printf 'basicConstraints=CA:FALSE\nkeyUsage=critical,keyEncipherment\n' >$W/nosign.ext
printf 'basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,timeStamping\n' >$W/tsa.ext

# Небольшой корректный PDF (одна пустая страница) с вычисленной таблицей xref.
pdf() {
  : >doc.pdf
  printf '%%PDF-1.4\n' >>doc.pdf
  o1=$(wc -c <doc.pdf); printf '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n' >>doc.pdf
  o2=$(wc -c <doc.pdf); printf '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n' >>doc.pdf
  o3=$(wc -c <doc.pdf); printf '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>\nendobj\n' >>doc.pdf
  x=$(wc -c <doc.pdf)
  printf 'xref\n0 4\n0000000000 65535 f \n%010d 00000 n \n%010d 00000 n \n%010d 00000 n \n' "$o1" "$o2" "$o3" >>doc.pdf
  printf 'trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n' "$x" >>doc.pdf
}
pdf
printf 'Другой документ: подпись не над doc.pdf\n' >$W/other.txt

# УЦ: ГОСТ Р 34.10-2012 256 бит, набор параметров tc26 A.
openssl req -x509 -newkey gost2012_256 -pkeyopt paramset:TCA -nodes -keyout ca.key -out ca.pem \
  -days $DAYS -utf8 -md_gost12_256 -subj "/CN=Тестовый УЦ ГОСТ carbone-reports" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign"

# user <имя> <алгоритм> <paramset> <serial> <ext> [subject]: ключ и сертификат, выданный ca.pem.
user() {
  openssl genpkey -algorithm "$2" -pkeyopt "paramset:$3" -out "$1.key"
  openssl req -new -key "$1.key" -out $W/$1.csr -utf8 -subj "${6:-/CN=Иванов Иван Иванович ($1)/O=Тест}"
  openssl x509 -req -in $W/$1.csr -CA ca.pem -CAkey ca.key -set_serial "$4" -days $DAYS \
    -extfile $W/$5.ext -out "$1.pem"
}
# Наборы параметров движка: TCA — id-tc26-gost-3410-2012-256-paramSetA,
# A — id-GostR3410-2001-CryptoPro-A-ParamSet; для 512 бит A — id-tc26-gost-3410-2012-512-paramSetA.
user user256a gost2012_256 TCA 0x1001 sign
user user256cp gost2012_256 A 0x1002 sign
user user512a gost2012_512 A 0x1003 sign
user other256 gost2012_256 TCA 0x1004 sign "/CN=Петров Пётр Петрович (other256)/O=Тест"
user nosign256 gost2012_256 TCA 0x1005 nosign
user tsa gost2012_256 TCA 0x1006 tsa "/CN=Тестовая служба меток времени ГОСТ/O=Тест"
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out tsa-rsa.key
openssl req -new -key tsa-rsa.key -out $W/tsa-rsa.csr -utf8 -subj "/CN=Тестовая служба меток времени RSA/O=Тест"
openssl x509 -req -in $W/tsa-rsa.csr -CA ca.pem -CAkey ca.key -set_serial 0x1007 -days $DAYS \
  -extfile $W/tsa.ext -out tsa-rsa.pem
# Сертификат с истёкшим сроком: `openssl ca` умеет задать даты в прошлом.
openssl genpkey -algorithm gost2012_256 -pkeyopt paramset:TCA -out expired256.key
openssl req -new -key expired256.key -out $W/expired256.csr -utf8 -subj "/CN=Иванов Иван Иванович (expired256)/O=Тест"
openssl ca -batch -config $W/cnf -name ca_expired -cert ca.pem -keyfile ca.key -in $W/expired256.csr \
  -startdate 20200101000000Z -enddate 20210101000000Z -extfile $W/sign.ext -notext -out expired256.pem

# sign <файл подписи> <имя ключа> <алгоритм хеша> [опции cms]: открепленная подпись DER над doc.pdf.
sign() {
  f=$1 k=$2 md=$3; shift 3
  openssl cms -sign -binary -in doc.pdf -signer "$k.pem" -inkey "$k.key" -md "$md" -outform DER -out "$f" "$@"
}
sign bes-256a.sig user256a md_gost12_256
sign bes-256cp.sig user256cp md_gost12_256
sign bes-512a.sig user512a md_gost12_512
sign bes-256a-chain.sig user256a md_gost12_256 -certfile ca.pem
sign bes-256a-other.sig other256 md_gost12_256
sign no-attrs.sig user256a md_gost12_256 -noattr
sign with-content.sig user256a md_gost12_256 -nodetach
openssl cms -sign -binary -in $W/other.txt -signer user256a.pem -inkey user256a.key -md md_gost12_256 \
  -outform DER -out bad-hash.sig

# Значение подписи — последний элемент SignerInfo, то есть последние 64 байта файла (256 бит).
tail -c 64 bes-256a.sig >$W/sigval.bin
# Испорченное значение подписи: последний байт файла xor 1.
n=$(wc -c <bes-256a.sig)
head -c $((n - 1)) bes-256a.sig >bad-value.sig
last=$(tail -c 1 bes-256a.sig | od -An -tu1 | tr -d ' ')
printf "\\$(printf '%03o' $((last ^ 1)))" >>bad-value.sig

# Сырые подписи pkeyutl над хешем doc.pdf (байты хеша — как выдает openssl dgst -binary).
openssl dgst -md_gost12_256 -binary doc.pdf >$W/h256.bin
openssl dgst -md_gost12_512 -binary doc.pdf >$W/h512.bin
openssl pkeyutl -sign -inkey user256a.key -in $W/h256.bin -out raw-256a.bin
openssl pkeyutl -sign -inkey user512a.key -in $W/h512.bin -out raw-512a.bin
openssl pkeyutl -verify -inkey user256a.key -in $W/h256.bin -sigfile raw-256a.bin
openssl pkeyutl -verify -inkey user512a.key -in $W/h512.bin -sigfile raw-512a.bin

# Метки времени над значением подписи bes-256a.sig: ГОСТ (Стрибог-256) и RSA (SHA-256).
openssl ts -query -data $W/sigval.bin -md_gost12_256 -cert -no_nonce -out $W/q-gost.tsq
openssl ts -reply -config $W/cnf -section tsa_gost -queryfile $W/q-gost.tsq -signer tsa.pem -inkey tsa.key \
  -token_out -out $W/token-gost.der
openssl ts -query -data $W/sigval.bin -sha256 -cert -no_nonce -out $W/q-rsa.tsq
openssl ts -reply -config $W/cnf -section tsa_rsa -queryfile $W/q-rsa.tsq -signer tsa-rsa.pem -inkey tsa-rsa.key \
  -token_out -out $W/token-rsa.der
openssl ts -verify -token_in -in $W/token-gost.der -data $W/sigval.bin -CAfile ca.pem
openssl ts -verify -token_in -in $W/token-rsa.der -data $W/sigval.bin -CAfile ca.pem

# Хеши doc.pdf в формате openssl dgst (для сверки Стрибога) и хеш пустого сообщения (для README).
openssl dgst -md_gost12_256 doc.pdf >doc.pdf.streebog256.hex
openssl dgst -md_gost12_512 doc.pdf >doc.pdf.streebog512.hex
printf '' | openssl dgst -md_gost12_256
printf '' | openssl dgst -md_gost12_512
EOF

# Шаг 2: CAdES-T — токен метки времени в неподписанный атрибут SignerInfo (pkijs).
node "$ROOT/scripts/gost-fixtures-cades-t.mjs" "$OUT/bes-256a.sig" "$WORK/token-gost.der" "$OUT/t-256a.sig"
node "$ROOT/scripts/gost-fixtures-cades-t.mjs" "$OUT/bes-256a.sig" "$WORK/token-rsa.der" "$OUT/t-256a-rsa.sig"

# Шаг 3: OpenSSL сам проверяет каждую корректную подпись; некорректные должны не проходить.
gost <<'EOF'
set -eu
for s in bes-256a bes-256cp bes-512a bes-256a-chain bes-256a-other no-attrs t-256a t-256a-rsa; do
  openssl cms -verify -noverify -binary -inform DER -in $s.sig -content doc.pdf -out /dev/null
done
openssl cms -verify -noverify -binary -inform DER -in with-content.sig -out /dev/null
openssl cms -verify -CAfile ca.pem -binary -inform DER -in bes-256a-chain.sig -content doc.pdf -out /dev/null
for s in bad-hash bad-value; do
  if openssl cms -verify -noverify -binary -inform DER -in $s.sig -content doc.pdf -out /dev/null 2>/dev/null; then
    echo "$s.sig неожиданно прошла проверку" >&2; exit 1
  fi
done
EOF

docker image rm "$IMAGE"
echo готово
