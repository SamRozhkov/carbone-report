#!/bin/sh
# Восстановление из каталога бэкапа: БД app и том storage. Останавливает api и web, очищает Redis.
set -eu
dir=${1:?использование: scripts/restore.sh backups/<каталог>}
dir=$(cd "$dir" && pwd)
cd "$(dirname "$0")/.." # корень проекта compose
for f in db.dump storage.tar.gz manifest.txt; do [ -f "$dir/$f" ] || { echo "нет $dir/$f" >&2; exit 1; }; done

echo "Проверка контрольных сумм…"
for f in db.dump storage.tar.gz; do
  want=$(grep "^$f " "$dir/manifest.txt" | sed 's/.*sha256=//')
  got=$( (sha256sum "$dir/$f" 2>/dev/null || shasum -a 256 "$dir/$f") | cut -d' ' -f1)
  [ "$want" = "$got" ] || { echo "контрольная сумма $f не совпадает" >&2; exit 1; }
done

# Полное имя тома storage этого проекта. «docker compose run -v storage:/data» не годится:
# compose сливает его с «storage:/data:ro» сервиса backup, и том остаётся только для чтения.
project=$(docker compose config | sed -n 's/^name: //p')
[ -n "$project" ] || { echo "не удалось прочитать конфигурацию compose — проверьте .env" >&2; exit 1; }
volume=$(docker volume ls -q --filter "label=com.docker.compose.project=$project" \
  --filter label=com.docker.compose.volume=storage)
[ -n "$volume" ] && [ "$(echo "$volume" | wc -l)" -eq 1 ] || {
  echo "не найден том storage проекта $project (запустите стек)" >&2
  exit 1
}

# Ручной бэкап («run --rm backup now») — отдельный одноразовый контейнер сервиса backup.
# Его нельзя прервать без потери копии, поэтому восстановление ждёт его окончания.
refuse_if_manual_backup() {
  if [ -n "$(docker ps -q --filter "label=com.docker.compose.project=$project" \
    --filter label=com.docker.compose.service=backup --filter label=com.docker.compose.oneoff=True)" ]; then
    echo "идёт ручной бэкап — дождитесь окончания и запустите restore.sh снова" >&2
    exit 1
  fi
}
refuse_if_manual_backup

# Бэкап по расписанию на время восстановления приостанавливается: иначе он может снять
# архив посреди замены файлов, и ротация будет доверять такой копии.
bk=$(docker compose --profile backup ps -q --status running backup)

echo "Будут ЗАМЕНЕНЫ база app и файлы хранилища (том $volume) данными из $(basename "$dir")."
echo "Redis (кэш шаблонов Carbone и счётчики попыток входа) будет очищен."
[ -z "$bk" ] || echo "Бэкап по расписанию (сервис backup) будет приостановлен на время восстановления."
printf 'Введите restore для продолжения: '
read -r answer || answer=
[ "$answer" = restore ] || { echo "отменено"; exit 1; }

# phase: none → stopped (api и web остановлены) → restoring (идёт замена базы) → db (база заменена)
# → storage (и хранилище) → finished.
phase=none
bk_stopped=
redis_flushed=
# Кэш Carbone в Redis (cr:carbone:tpl:<id> → {version, carboneId}) после замены базы устаревает:
# номер версии шаблона из бэкапа может совпасть с закэшированным, и отчёт молча сформируется по
# старому шаблону в Carbone. Всё в Redis одноразовое (кэш и счётчики), поэтому он очищается целиком.
redis_hint="docker compose exec -T redis redis-cli FLUSHALL (или docker compose restart redis)"
on_exit() {
  [ "$1" -ne 0 ] || return 0
  if [ "$phase" != none ] && [ "$phase" != finished ]; then
    {
      echo
      echo "ОШИБКА восстановления. Сервисы api и web остановлены."
      case $phase in
        stopped) echo "База app НЕ изменена, хранилище не тронуто." ;;
        restoring) echo "Замена базы прервана: база app, вероятно, не изменена (откатывается целиком) — проверьте; хранилище не тронуто." ;;
        db) echo "База app УЖЕ ЗАМЕНЕНА данными из бэкапа; хранилище могло остаться прежним или восстановиться частично." ;;
        storage) echo "База app и хранилище восстановлены, но api и web не запустились." ;;
      esac
      echo "Дальше: устраните причину и запустите restore.sh снова"
      echo "или верните стек как есть: docker compose up -d --wait api web"
      if [ "$phase" = db ] || { [ "$phase" = storage ] && [ -z "$redis_flushed" ]; }; then
        echo "Если возвращаете стек как есть, сначала очистите устаревший кэш Redis: $redis_hint"
      fi
    } >&2
  fi
  if [ -n "$bk_stopped" ]; then
    docker compose --profile backup start backup >&2 || echo "не удалось запустить сервис backup" >&2
  fi
}
trap 'on_exit $?' EXIT
trap 'exit 130' INT TERM

if [ -n "$bk" ]; then
  docker compose --profile backup stop backup
  bk_stopped=1
fi
phase=stopped
docker compose stop api web
docker compose up -d --wait postgres
# Ручной бэкап мог стартовать, пока шло подтверждение.
refuse_if_manual_backup
# База заменяется целиком в ОДНОЙ транзакции: сначала схемы drizzle и public удаляются, затем
# выполняется SQL из дампа. «pg_restore --clean» удалил бы только объекты из дампа, и в стеке
# с более новой схемой лишние таблицы и миграции помешали бы восстановлению.
# SQL сначала пишется в файл: если pg_restore упадёт на середине, psql не закоммитит обрезанный
# скрипт. psql -1 с несколькими -f (PostgreSQL ≥15) оборачивает их в одну транзакцию.
phase=restoring
docker compose cp "$dir/db.dump" postgres:/tmp/restore.dump
docker compose exec -T postgres sh -ec '
  trap "rm -f /tmp/restore.dump /tmp/restore.sql /tmp/restore-pre.sql" EXIT
  pg_restore --no-owner -f /tmp/restore.sql /tmp/restore.dump
  printf "%s\n" "DROP SCHEMA IF EXISTS drizzle CASCADE;" "DROP SCHEMA IF EXISTS public CASCADE;" \
    "CREATE SCHEMA public;" > /tmp/restore-pre.sql
  psql -U app -d app -1 -v ON_ERROR_STOP=1 -q -f /tmp/restore-pre.sql -f /tmp/restore.sql
'
phase=db
# Тот же entrypoint, что у сервиса backup (режим restore-storage), но том — на запись.
# Образ должен совпадать с image сервиса backup в docker-compose.yml.
docker run --rm -v "$volume":/data -v "$PWD/docker/backup":/backup:ro -v "$dir":/restore:ro \
  --entrypoint /backup/entrypoint.sh postgres:17-alpine restore-storage
phase=storage
# api остановлен — кэш не заполнится заново старыми данными до запуска. Redis без снимков на диск,
# так что запуск (если он был остановлен) тоже даёт пустую базу, но FLUSHALL выполняется всегда.
if docker compose up -d --wait redis && docker compose exec -T redis redis-cli FLUSHALL; then
  redis_flushed=1
  echo "Redis очищен."
else
  echo "ВНИМАНИЕ: не удалось очистить Redis — кэш шаблонов Carbone может быть устаревшим." >&2
  echo "Когда Redis заработает, выполните: $redis_hint" >&2
fi
docker compose up -d --wait api web
phase=finished
if [ -n "$bk_stopped" ]; then
  bk_stopped=
  docker compose --profile backup start backup ||
    echo "не удалось запустить сервис backup: docker compose --profile backup up -d backup" >&2
fi
echo "Восстановление завершено."
