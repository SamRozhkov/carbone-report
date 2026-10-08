#!/bin/sh
set -eu
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/lib.sh"
case "${1:-cron}" in
  now) exec /backup/backup.sh ;;
  restore-storage)
    # Используется scripts/restore.sh. local: распаковка в /data (том смонтирован на запись этим run);
    # s3: распаковка во временный каталог и rclone sync в бакет — объекты, которых нет в архиве, удаляются.
    check_storage_backend
    a=/restore/storage.tar.gz
    [ -f "$a" ] || { echo "нет $a" >&2; exit 1; }
    # Все проверки — до изменений: при любой ошибке хранилище остаётся нетронутым.
    if [ "$STORAGE_BACKEND" = local ]; then
      mountpoint -q /data || { echo "/data не смонтирован" >&2; exit 1; }
    fi
    if ! { gzip -t "$a" && tar -tzf "$a" >/dev/null; }; then echo "архив повреждён" >&2; exit 1; fi
    if [ -f /restore/manifest.txt ]; then
      want=$(sed -n 's/^storage\.tar\.gz .*sha256=\([0-9a-f]*\).*$/\1/p' /restore/manifest.txt)
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
  cron)
    : "${BACKUP_CRON:=0 3 * * *}"
    # Ровно 5 полей: иначе crond молча не выполнит задание (или примет часть команды за поле).
    # set -f — чтобы «*» не раскрылись в имена файлов при разбиении на поля.
    set -f
    # shellcheck disable=SC2086
    set -- $BACKUP_CRON
    set +f
    case "$BACKUP_CRON" in *'
'*) echo "BACKUP_CRON: ожидается 5 полей cron" >&2; exit 2 ;; esac
    [ "$#" -eq 5 ] || { echo "BACKUP_CRON: ожидается 5 полей cron" >&2; exit 2; }
    # Та же проверка, что в backup.sh: неверный срок виден сразу при старте, а не в 3 часа ночи.
    check_backup_timeout
    check_storage_backend
    mkdir -p /etc/crontabs
    # crond не передаёт окружение заданиям — сохраняем нужные переменные.
    # export -p (ash) выводит значения в одинарных кавычках с экранированием — файл безопасно
    # подключать через «.» при любых символах в пароле. Файл содержит пароли (PGPASSWORD, S3_SECRET_ACCESS_KEY) — только для root.
    export -p | grep -E '^export (PG|BACKUP_|LOCK_KEY|TZ|STORAGE_BACKEND|S3_)' > /backup.env
    chmod 600 /backup.env
    # Вывод задания — в stdout/stderr PID 1 (crond), чтобы он попал в docker logs.
    echo "$BACKUP_CRON . /backup.env && /backup/backup.sh >/proc/1/fd/1 2>/proc/1/fd/2" > /etc/crontabs/root
    echo "расписание бэкапа: $BACKUP_CRON (TZ=${TZ:-UTC})"
    exec crond -f -d 6 -c /etc/crontabs ;;
  *) echo "режимы: cron | now | restore-storage" >&2; exit 2 ;;
esac
