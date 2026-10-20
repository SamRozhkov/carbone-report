#!/bin/sh
# Тестовые сертификаты подписи PDF (§39.7). Не секреты: пароль .p12 — test-password.
# Нужен OpenSSL 3+ (LibreSSL не подходит): OPENSSL=/opt/homebrew/opt/openssl@3/bin/openssl sh make.sh
set -eu
cd "$(dirname "$0")"
O=${OPENSSL:-openssl}
$O version | grep -Eq '^OpenSSL [3-9]' || { echo "нужен OpenSSL 3+, а не: $($O version)" >&2; exit 1; }
P=pass:test-password
DAYS=36500
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

printf 'basicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n' >"$tmp/ca.ext"
printf 'basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature,nonRepudiation\n' >"$tmp/sign.ext"
printf 'basicConstraints=CA:FALSE\nkeyUsage=critical,keyEncipherment\n' >"$tmp/nosign.ext"
printf 'basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,timeStamping\n' >"$tmp/tsa.ext"

# Корневой УЦ (самоподписанный) и промежуточный — для цепочки из трёх сертификатов.
$O req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.pem -days $DAYS -utf8 \
  -subj "/CN=Тестовый УЦ carbone-reports" \
  -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign"
$O genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$tmp/int.key"
$O req -new -key "$tmp/int.key" -out "$tmp/int.csr" -utf8 -subj "/CN=Тестовый промежуточный УЦ"
$O x509 -req -in "$tmp/int.csr" -CA ca.pem -CAkey ca.key -set_serial 0x2001 -days $DAYS \
  -extfile "$tmp/ca.ext" -out "$tmp/int.pem"

# key <имя> <алгоритм genpkey> [опции genpkey...]
key() { n=$1; shift; $O genpkey -algorithm "$@" -out "$tmp/$n.key"; }
# cert <имя> <serial> <ext> [ключ УЦ] [сертификат УЦ] [subject]
cert() {
  $O req -new -key "$tmp/$1.key" -out "$tmp/$1.csr" -utf8 -subj "${6:-/CN=Иванов Иван Иванович ($1)/O=Тест}"
  $O x509 -req -in "$tmp/$1.csr" -CA "${5:-ca.pem}" -CAkey "${4:-ca.key}" -set_serial "$2" \
    -days $DAYS -extfile "$tmp/$3.ext" -out "$tmp/$1.pem"
}
# p12 <файл> <ключ> <сертификат> <цепочка> [доп. опции]
p12() { f=$1 k=$2 c=$3 ch=$4; shift 4; $O pkcs12 -export -inkey "$k" -in "$c" -certfile "$ch" -passout $P -out "$f" "$@"; }

key rsa RSA -pkeyopt rsa_keygen_bits:2048 && cert rsa 0x1001 sign
key ec EC -pkeyopt ec_paramgen_curve:P-256 && cert ec 0x1002 sign
key ec384 EC -pkeyopt ec_paramgen_curve:P-384 && cert ec384 0x1003 sign
key rsa1024 RSA -pkeyopt rsa_keygen_bits:1024 && cert rsa1024 0x1004 sign
key nosign RSA -pkeyopt rsa_keygen_bits:2048 && cert nosign 0x1005 nosign
key chain3 RSA -pkeyopt rsa_keygen_bits:2048 && cert chain3 0x1006 sign "$tmp/int.key" "$tmp/int.pem"
key rsainn RSA -pkeyopt rsa_keygen_bits:2048 && cert rsainn 0x1008 sign ca.key ca.pem "/CN=Иванов Иван Иванович (rsa-inn)/O=Тест/1.2.643.3.131.1.1=007700000000"
key tsa RSA -pkeyopt rsa_keygen_bits:2048 && cert tsa 0x1007 tsa

p12 rsa.p12 "$tmp/rsa.key" "$tmp/rsa.pem" ca.pem
p12 rsa-legacy.p12 "$tmp/rsa.key" "$tmp/rsa.pem" ca.pem -legacy
p12 rsa-inn.p12 "$tmp/rsainn.key" "$tmp/rsainn.pem" ca.pem
p12 ec.p12 "$tmp/ec.key" "$tmp/ec.pem" ca.pem
p12 ec384.p12 "$tmp/ec384.key" "$tmp/ec384.pem" ca.pem
p12 rsa1024.p12 "$tmp/rsa1024.key" "$tmp/rsa1024.pem" ca.pem
p12 nosign.p12 "$tmp/nosign.key" "$tmp/nosign.pem" ca.pem
cat "$tmp/int.pem" ca.pem >"$tmp/chain.pem"
p12 chain3.p12 "$tmp/chain3.key" "$tmp/chain3.pem" "$tmp/chain.pem"
# Слишком много итераций (защита от DoS): и шифрование, и MAC; только шифрование (MAC — 1 итерация).
p12 iter-high.p12 "$tmp/rsa.key" "$tmp/rsa.pem" ca.pem -iter 1000000
p12 iter-high-pbe.p12 "$tmp/rsa.key" "$tmp/rsa.pem" ca.pem -iter 1000000 -nomaciter
# Пароль кириллицей: PBES2 (UTF-8) и -legacy (BMPString).
cyr() { f=$1; shift; $O pkcs12 -export -inkey "$tmp/rsa.key" -in "$tmp/rsa.pem" -certfile ca.pem -passout 'pass:пароль1' -out "$f" "$@"; }
cyr rsa-cyr.p12
cyr rsa-cyr-legacy.p12 -legacy
# Файл только с ключом и файл без ключа.
$O pkcs12 -export -nocerts -inkey "$tmp/rsa.key" -passout $P -out keyonly.p12
$O pkcs12 -export -nokeys -in "$tmp/rsa.pem" -certfile ca.pem -passout $P -out nokey.p12
# Служба меток времени для тестов: ключ без пароля.
cp "$tmp/tsa.pem" tsa.pem
cp "$tmp/tsa.key" tsa.key
echo готово
