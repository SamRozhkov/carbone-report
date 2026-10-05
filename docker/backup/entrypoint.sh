#!/bin/sh
set -eu
case "${1:-cron}" in
  now) exec /backup/backup.sh ;;
  restore-storage)
    # Используется scripts/restore.sh: распаковывает архив в /data (том смонтирован на запись этим run).
    a=/restore/storage.tar.gz
    [ -f "$a" ] || { echo "нет $a" >&2; exit 1; }
    # Все проверки — до удаления: при любой ошибке /data остаётся нетронутым.
    mountpoint -q /data || { echo "/data не смонтирован" >&2; exit 1; }
    if ! { gzip -t "$a" && tar -tzf "$a" >/dev/null; }; then echo "архив повреждён" >&2; exit 1; fi
    if [ -f /restore/manifest.txt ]; then
      want=$(sed -n 's/^storage\.tar\.gz .*sha256=\([0-9a-f]*\).*$/\1/p' /restore/manifest.txt)
      got=$(sha256sum "$a" | cut -d' ' -f1)
      [ -n "$want" ] && [ "$want" = "$got" ] || { echo "sha256 архива не совпадает с manifest.txt" >&2; exit 1; }
    fi
    find /data -mindepth 1 -delete
    tar -xzf /restore/storage.tar.gz -C /data
    echo "хранилище восстановлено" ;;
  cron)
    : "${BACKUP_CRON:=0 3 * * *}"
    mkdir -p /etc/crontabs
    # crond не передаёт окружение заданиям — сохраняем нужные переменные.
    # export -p (ash) выводит значения в одинарных кавычках с экранированием — файл безопасно
    # подключать через «.» при любых символах в пароле. Файл содержит пароль — только для root.
    export -p | grep -E '^export (PG|BACKUP_|LOCK_KEY|TZ)' > /backup.env
    chmod 600 /backup.env
    # Вывод задания — в stdout/stderr PID 1 (crond), чтобы он попал в docker logs.
    echo "$BACKUP_CRON . /backup.env && /backup/backup.sh >/proc/1/fd/1 2>/proc/1/fd/2" > /etc/crontabs/root
    echo "расписание бэкапа: $BACKUP_CRON (TZ=${TZ:-UTC})"
    exec crond -f -d 6 -c /etc/crontabs ;;
  *) echo "режимы: cron | now | restore-storage" >&2; exit 2 ;;
esac
