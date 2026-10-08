#!/bin/sh
# Архив хранилища в <каталог>/storage.tar.gz. Вызывается из backup.sh под исключительной блокировкой.
# local: каталог /data как есть. *.tmp — временные файлы атомарной записи API (<файл>.<uuid>.tmp →
#   rename); они исчезают посреди чтения и в архиве не нужны. tar из busybox: любая ошибка, включая
#   исчезнувший файл, даёт код 1 — это сбой (лучше лишний неудачный бэкап, чем неполный).
# s3: копия бакета (rclone copy) во временном каталоге <каталог>/.s3-copy, затем tar этого каталога.
#   Временных объектов на S3 нет (запись — один PutObject). Временный каталог удаляется всегда,
#   в том числе по TERM от timeout.
# Формат одинаков для обоих режимов: пути относительно корня хранилища (./templates/…, ./reports/…),
# поэтому архив любого режима восстанавливается в любой.
set -eu
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/lib.sh"
dir=${1:?использование: archive-storage.sh <каталог бэкапа>}
check_storage_backend
case $STORAGE_BACKEND in
  local) exec tar -czf "$dir/storage.tar.gz" --exclude='*.tmp' -C /data . ;;
  s3)
    s3_env
    tmp="$dir/.s3-copy"
    pid=
    # trap sh выполняется только после возврата текущей foreground-команды, поэтому rclone и tar
    # запускаются в фоне и ожидаются через wait: TERM от timeout прерывает wait сразу, cleanup
    # убивает дочерний процесс и удаляет временный каталог (KILL через 60 с уже не успевает).
    cleanup() {
      if [ -n "$pid" ]; then kill "$pid" 2>/dev/null || true; wait "$pid" 2>/dev/null || true; fi
      rm -rf "$tmp"
    }
    # run: команда в фоне; код возврата — код команды (при TERM wait прерывается, trap завершает скрипт).
    run() {
      "$@" &
      pid=$!
      rc=0
      wait "$pid" || rc=$?
      pid=
      return "$rc"
    }
    trap cleanup EXIT
    trap 'exit 143' TERM
    trap 'exit 130' INT
    mkdir "$tmp"
    run rclone copy --checksum "s3:$S3_BUCKET" "$tmp"
    run tar -czf "$dir/storage.tar.gz" -C "$tmp" . ;;
esac
