#!/bin/sh
# Сервис s3: SeaweedFS (официальный образ chrislusf/seaweedfs) — master, volume, filer и S3-шлюз
# в одном процессе (weed mini), данные в /data. Учётная запись S3 создаётся при каждом старте из
# S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY: /etc/seaweedfs/s3.json пишется внутри контейнера (не на томе,
# не в репозитории), права 600. Смена ключей — правка .env и перезапуск; данные на томе не меняются.
set -eu
: "${S3_ACCESS_KEY_ID:?задайте S3_ACCESS_KEY_ID}" "${S3_SECRET_ACCESS_KEY:?задайте S3_SECRET_ACCESS_KEY}"
# Значения подставляются в JSON без экранирования — допустимы только безопасные символы.
for v in "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY"; do
  case $v in
    *[!A-Za-z0-9._~+/=-]*)
      echo "S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY: допустимы A-Z, a-z, 0-9 и . _ ~ + / = - (например, openssl rand -hex 32)" >&2
      exit 2 ;;
  esac
done
umask 077
mkdir -p /etc/seaweedfs
printf '{"identities":[{"name":"app","credentials":[{"accessKey":"%s","secretKey":"%s"}],"actions":["Admin","Read","Write","List"]}]}\n' \
  "$S3_ACCESS_KEY_ID" "$S3_SECRET_ACCESS_KEY" > /etc/seaweedfs/s3.json
chown seaweed:seaweed /etc/seaweedfs/s3.json
# Только S3 на порту 8333: без WebDAV, Admin UI, IAM API, Iceberg и Lance. Бакет создаёт API
# (S3_CREATE_BUCKET), поэтому автосоздание при записи выключено; удаление непустого бакета запрещено.
# /entrypoint.sh образа исправляет владельца /data и запускает weed от пользователя seaweed.
exec /entrypoint.sh mini -dir=/data -s3.config=/etc/seaweedfs/s3.json \
  -s3.autoCreateBucket=false -s3.allowDeleteBucketNotEmpty=false -s3.iam=false \
  -s3.port.iceberg=0 -s3.port.lance=0 -webdav=false -admin.ui=false
