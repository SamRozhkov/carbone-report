# shellcheck shell=sh
# Общие проверки для entrypoint.sh и backup.sh (подключается через «.»).

# check_backup_timeout: BACKUP_TIMEOUT — целое число секунд ≥1 (по умолчанию 3600). Ведущие нули
# убираются (030 → 30, 00 → «»); пустое, нулевое или нечисловое значение — сообщение и выход с кодом 2.
check_backup_timeout() {
  : "${BACKUP_TIMEOUT:=3600}"
  BACKUP_TIMEOUT=${BACKUP_TIMEOUT#"${BACKUP_TIMEOUT%%[!0]*}"}
  case $BACKUP_TIMEOUT in ''|*[!0-9]*) echo "BACKUP_TIMEOUT должен быть целым числом секунд ≥1" >&2; exit 2;; esac
}
