# shellcheck shell=sh
# Общие проверки для entrypoint.sh и backup.sh (подключается через «.»).

# check_backup_timeout: BACKUP_TIMEOUT — целое число секунд ≥1 (по умолчанию 3600). Ведущие нули
# убираются (030 → 30, 00 → «»); пустое, нулевое или нечисловое значение — сообщение и выход с кодом 2.
check_backup_timeout() {
  : "${BACKUP_TIMEOUT:=3600}"
  BACKUP_TIMEOUT=${BACKUP_TIMEOUT#"${BACKUP_TIMEOUT%%[!0]*}"}
  case $BACKUP_TIMEOUT in ''|*[!0-9]*) echo "BACKUP_TIMEOUT должен быть целым числом секунд ≥1" >&2; exit 2;; esac
}

# check_storage_backend: STORAGE_BACKEND — local (по умолчанию, каталог /data) или s3 (бакет через
# rclone). Для s3 нужны S3_BUCKET и rclone в образе; ключи S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY —
# оба или ни одного (без них rclone берёт учётные данные из окружения: IRSA в k8s).
# Иначе — сообщение и выход с кодом 2.
check_storage_backend() {
  : "${STORAGE_BACKEND:=local}"
  case $STORAGE_BACKEND in
    local) ;;
    s3)
      [ -n "${S3_BUCKET:-}" ] || { echo "S3_BUCKET обязателен при STORAGE_BACKEND=s3" >&2; exit 2; }
      case "${S3_ACCESS_KEY_ID:+1}${S3_SECRET_ACCESS_KEY:+1}" in
        1) echo "S3_ACCESS_KEY_ID и S3_SECRET_ACCESS_KEY задаются вместе (или ни один — учётные данные из окружения, IRSA)" >&2; exit 2 ;;
      esac
      command -v rclone >/dev/null || { echo "rclone не найден: образ backup собирается из docker/backup/Dockerfile" >&2; exit 2; } ;;
    *) echo "STORAGE_BACKEND: ожидается local или s3" >&2; exit 2 ;;
  esac
}

# s3_env: удалённый ресурс rclone «s3:» из переменных окружения (RCLONE_CONFIG_S3_*), без файла
# конфигурации с секретами. С S3_ENDPOINT — провайдер SeaweedFS (сервис s3 в compose; для другого
# S3-совместимого хранилища — S3_RCLONE_PROVIDER, например Other), без него — AWS.
# NO_CHECK_BUCKET: бакет создаёт API (S3_CREATE_BUCKET), rclone его не создаёт.
# RCLONE_CONFIG="": конфигурация только в памяти — rclone не ищет файл и не пишет NOTICE
# «Config file … not found». Без ключей — env_auth (IRSA).
s3_env() {
  RCLONE_CONFIG=
  RCLONE_CONFIG_S3_TYPE=s3
  if [ -n "${S3_ENDPOINT:-}" ]; then
    RCLONE_CONFIG_S3_PROVIDER=${S3_RCLONE_PROVIDER:-SeaweedFS}
    RCLONE_CONFIG_S3_ENDPOINT=$S3_ENDPOINT
  else
    RCLONE_CONFIG_S3_PROVIDER=AWS
    RCLONE_CONFIG_S3_ENDPOINT=
  fi
  # Без ключей — учётные данные из окружения (переменные AWS_*, IRSA в k8s).
  if [ -n "${S3_ACCESS_KEY_ID:-}" ]; then
    RCLONE_CONFIG_S3_ENV_AUTH=false
    RCLONE_CONFIG_S3_ACCESS_KEY_ID=$S3_ACCESS_KEY_ID
    RCLONE_CONFIG_S3_SECRET_ACCESS_KEY=$S3_SECRET_ACCESS_KEY
  else
    RCLONE_CONFIG_S3_ENV_AUTH=true
    RCLONE_CONFIG_S3_ACCESS_KEY_ID=
    RCLONE_CONFIG_S3_SECRET_ACCESS_KEY=
  fi
  RCLONE_CONFIG_S3_REGION=${S3_REGION:-us-east-1}
  RCLONE_CONFIG_S3_FORCE_PATH_STYLE=${S3_FORCE_PATH_STYLE:-false}
  RCLONE_CONFIG_S3_NO_CHECK_BUCKET=true
  export RCLONE_CONFIG RCLONE_CONFIG_S3_TYPE RCLONE_CONFIG_S3_PROVIDER RCLONE_CONFIG_S3_ENDPOINT \
    RCLONE_CONFIG_S3_ENV_AUTH RCLONE_CONFIG_S3_ACCESS_KEY_ID RCLONE_CONFIG_S3_SECRET_ACCESS_KEY \
    RCLONE_CONFIG_S3_REGION RCLONE_CONFIG_S3_FORCE_PATH_STYLE RCLONE_CONFIG_S3_NO_CHECK_BUCKET
}
