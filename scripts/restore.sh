#!/bin/sh
# Восстановление из каталога бэкапа: БД app и том storage. Останавливает api и web.
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

# Бэкап по расписанию на время восстановления приостанавливается: иначе он может снять
# архив посреди замены файлов, и ротация будет доверять такой копии.
bk=$(docker compose --profile backup ps -q --status running backup)

echo "Будут ЗАМЕНЕНЫ база app и файлы хранилища (том $volume) данными из $(basename "$dir")."
[ -z "$bk" ] || echo "Бэкап по расписанию (сервис backup) будет приостановлен на время восстановления."
printf 'Введите restore для продолжения: '
read -r answer || answer=
[ "$answer" = restore ] || { echo "отменено"; exit 1; }

# phase: none → stopped (api и web остановлены) → db (база заменена) → storage (и хранилище) → finished.
phase=none
bk_stopped=
on_exit() {
  [ "$1" -ne 0 ] || return 0
  if [ "$phase" != none ] && [ "$phase" != finished ]; then
    {
      echo
      echo "ОШИБКА восстановления. Сервисы api и web остановлены."
      case $phase in
        stopped) echo "База app НЕ изменена (pg_restore откатывается целиком), хранилище не тронуто." ;;
        db) echo "База app УЖЕ ЗАМЕНЕНА данными из бэкапа; хранилище могло остаться прежним или восстановиться частично." ;;
        storage) echo "База app и хранилище восстановлены, но api и web не запустились." ;;
      esac
      echo "Дальше: устраните причину и запустите restore.sh снова"
      echo "или верните стек как есть: docker compose up -d --wait api web"
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
docker compose exec -T postgres pg_restore -U app -d app --clean --if-exists --single-transaction --no-owner < "$dir/db.dump"
phase=db
# Тот же entrypoint, что у сервиса backup (режим restore-storage), но том — на запись.
# Образ должен совпадать с image сервиса backup в docker-compose.yml.
docker run --rm -v "$volume":/data -v "$PWD/docker/backup":/backup:ro -v "$dir":/restore:ro \
  --entrypoint /backup/entrypoint.sh postgres:17-alpine restore-storage
phase=storage
docker compose up -d --wait api web
phase=finished
if [ -n "$bk_stopped" ]; then
  bk_stopped=
  docker compose --profile backup start backup ||
    echo "не удалось запустить сервис backup: docker compose --profile backup up -d" >&2
fi
echo "Восстановление завершено."
