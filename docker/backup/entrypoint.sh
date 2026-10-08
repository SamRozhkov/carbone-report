#!/bin/sh
set -eu
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/lib.sh"
case "${1:-agent}" in
  agent)
    # Агент бэкапа (apps/backup-agent): расписание BACKUP_CRON в часовом поясе TZ, бэкапы и
    # восстановление из админки. BACKUP_CRON и токен проверяет агент (код 2), здесь — то же,
    # что проверяет backup.sh: неверное значение видно сразу при старте, а не в 3 часа ночи.
    check_backup_timeout
    check_storage_backend
    exec node /agent/dist/main.js ;;
  now)
    # Ручной бэкап: docker compose run --rm backup now. Одна операция за раз — тот же замок
    # /backups/.op.lock, что у агента. fd 9 наследует backup.sh, замок держится до его конца.
    mkdir -p /backups
    exec 9>>/backups/.op.lock
    flock -n 9 || { echo "идёт другая операция с бэкапами (агент) — повторите позже" >&2; exit 75; }
    exec "$(dirname "$0")/backup.sh" ;;
  restore-storage)
    # Агент: RESTORE_DIR=/backups/<имя>; scripts/restore.sh: каталог бэкапа смонтирован в /restore.
    # local: распаковка в /data (том смонтирован на запись); s3: распаковка во временный каталог
    # и rclone sync в бакет — объекты, которых нет в архиве, удаляются.
    check_storage_backend
    src=${RESTORE_DIR:-/restore}
    a=$src/storage.tar.gz
    [ -f "$a" ] || { echo "нет $a" >&2; exit 1; }
    # Все проверки — до изменений: при любой ошибке хранилище остаётся нетронутым.
    if [ "$STORAGE_BACKEND" = local ]; then
      mountpoint -q /data || { echo "/data не смонтирован" >&2; exit 1; }
    fi
    if ! { gzip -t "$a" && tar -tzf "$a" >/dev/null; }; then echo "архив повреждён" >&2; exit 1; fi
    if [ -f "$src/manifest.txt" ]; then
      want=$(sed -n 's/^storage\.tar\.gz .*sha256=\([0-9a-f]*\).*$/\1/p' "$src/manifest.txt")
      got=$(sha256sum "$a" | cut -d' ' -f1)
      [ -n "$want" ] && [ "$want" = "$got" ] || { echo "sha256 архива не совпадает с manifest.txt" >&2; exit 1; }
    fi
    if [ "$STORAGE_BACKEND" = local ]; then
      find /data -mindepth 1 -delete
      tar -xzf "$a" -C /data
    else
      s3_env
      tmp=$(mktemp -d)
      trap 'rm -rf "$tmp"' EXIT
      tar -xzf "$a" -C "$tmp"
      rclone sync --checksum "$tmp" "s3:$S3_BUCKET"
    fi
    echo "хранилище восстановлено ($STORAGE_BACKEND)" ;;
  *) echo "режимы: agent | now | restore-storage" >&2; exit 2 ;;
esac
