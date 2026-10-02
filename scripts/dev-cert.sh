#!/usr/bin/env sh
# Самоподписанный сертификат для локальной проверки прод-режима. Не для боевого использования.
set -eu
cd "$(dirname "$0")/.."
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
  -keyout certs/privkey.pem -out certs/fullchain.pem
echo "Сертификат создан: certs/fullchain.pem, certs/privkey.pem"
