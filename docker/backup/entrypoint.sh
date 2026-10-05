#!/bin/sh
set -eu
case "${1:-cron}" in
  now) exec /backup/backup.sh ;;
  restore-storage)
    # Используется scripts/restore.sh: распаковывает архив в /data (том смонтирован на запись этим run).
    [ -f /restore/storage.tar.gz ] || { echo "нет /restore/storage.tar.gz" >&2; exit 1; }
    find /data -mindepth 1 -delete
    tar -xzf /restore/storage.tar.gz -C /data
    echo "хранилище восстановлено" ;;
  cron)
    : "${BACKUP_CRON:=0 3 * * *}"
    mkdir -p /etc/crontabs
    # crond не передаёт окружение заданиям — сохраняем нужные переменные.
    # Значения просто берутся в двойные кавычки без экранирования: это безопасно, потому что
    # POSTGRES_PASSWORD в проекте только hex (см. .env.example), а остальные — расписание,
    # числа, имена хостов и зона без символов " $ ` \.
    env | grep -E '^(PG|BACKUP_|LOCK_KEY|TZ)' | sed 's/^/export /; s/=\(.*\)$/="\1"/' > /backup.env
    # Вывод задания — в stdout/stderr PID 1 (crond), чтобы он попал в docker logs.
    echo "$BACKUP_CRON . /backup.env && /backup/backup.sh >/proc/1/fd/1 2>/proc/1/fd/2" > /etc/crontabs/root
    echo "расписание бэкапа: $BACKUP_CRON (TZ=${TZ:-UTC})"
    exec crond -f -d 6 -c /etc/crontabs ;;
  *) echo "режимы: cron | now | restore-storage" >&2; exit 2 ;;
esac
