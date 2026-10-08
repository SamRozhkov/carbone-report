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
    trap 'rm -rf "$tmp"' EXIT
    trap 'exit 143' TERM
    trap 'exit 130' INT
    mkdir "$tmp"
    rclone copy "s3:$S3_BUCKET" "$tmp"
    tar -czf "$dir/storage.tar.gz" -C "$tmp" . ;;
esac
