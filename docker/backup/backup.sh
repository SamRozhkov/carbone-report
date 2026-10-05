#!/bin/sh
# Один бэкап: дамп базы и архив хранилища под исключительной advisory-блокировкой
# (API на это время откладывает удаления файлов — дамп и архив согласованы).
set -eu
: "${PGHOST:=postgres}" "${PGUSER:=app}" "${PGDATABASE:=app}" "${LOCK_KEY:=726100001}"
: "${BACKUP_KEEP:=14}"
PGAPPNAME=backup
export PGHOST PGUSER PGDATABASE PGAPPNAME
: "${PGPASSWORD:?не задан PGPASSWORD}"

name=$(date -u +%Y-%m-%dT%H-%M-%SZ)
dir="/backups/$name.partial"
mkdir -p "$dir"
echo "бэкап $name: начало"

fail() {
  echo "бэкап $name: ошибка ($1), оставлен $dir" >&2
  exit 1
}

# Блокировка сессионная: она держится, пока psql выполняет \! (pg_dump и tar), и снимается
# явным unlock или — при любом сбое — закрытием сессии, так что API не останется заблокированным.
# Код возврата \! psql игнорирует (ON_ERROR_STOP на него не действует), поэтому успех каждого
# шага фиксируется файлом-маркером и проверяется после psql.
psql -v ON_ERROR_STOP=1 -q -o /dev/null <<SQL || fail "psql"
select pg_advisory_lock($LOCK_KEY);
\! pg_dump -Fc -f "$dir/db.dump" && touch "$dir/.dump-ok"
\! tar -czf "$dir/storage.tar.gz" -C /data . && touch "$dir/.storage-ok"
select pg_advisory_unlock($LOCK_KEY);
SQL

[ -f "$dir/.dump-ok" ] && [ -s "$dir/db.dump" ] || fail "pg_dump"
[ -f "$dir/.storage-ok" ] && [ -s "$dir/storage.tar.gz" ] || fail "tar"
rm -f "$dir/.dump-ok" "$dir/.storage-ok"

migration=$(psql -tA -c 'select hash from drizzle.__drizzle_migrations order by created_at desc limit 1' || echo '?')
{
  echo "created_utc=$name"
  echo "last_migration=${migration:-?}"
  for f in db.dump storage.tar.gz; do
    echo "$f size=$(wc -c < "$dir/$f" | tr -d ' ') sha256=$(sha256sum "$dir/$f" | cut -d' ' -f1)"
  done
} > "$dir/manifest.txt"

mv "$dir" "/backups/$name"
echo "бэкап $name: готово"

# Ротация: только завершённые каталоги с именем-датой, новые сверху.
ls -1d /backups/????-??-??T??-??-??Z 2>/dev/null | sort -r | tail -n +"$((BACKUP_KEEP + 1))" | while read -r old; do
  rm -rf "$old" && echo "удалён старый бэкап $(basename "$old")"
done
