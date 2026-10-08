# Образ сервиса backup: pg_dump из postgres:17-alpine (та же мажорная версия, что у сервера)
# и rclone для режима STORAGE_BACKEND=s3. Скрипты не копируются: compose монтирует docker/backup в /backup.
FROM postgres:17-alpine
RUN apk add --no-cache rclone
