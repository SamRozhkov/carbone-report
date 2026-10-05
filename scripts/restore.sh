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
volume=$(docker volume ls -q --filter "label=com.docker.compose.project=$project" \
  --filter label=com.docker.compose.volume=storage)
[ -n "$volume" ] && [ "$(echo "$volume" | wc -l)" -eq 1 ] || {
  echo "не найден том storage проекта $project (запустите стек)" >&2
  exit 1
}

echo "Будут ЗАМЕНЕНЫ база app и файлы хранилища (том $volume) данными из $(basename "$dir")."
printf 'Введите restore для продолжения: '
read -r answer || answer=
[ "$answer" = restore ] || { echo "отменено"; exit 1; }

docker compose stop api web
docker compose up -d --wait postgres
docker compose exec -T postgres pg_restore -U app -d app --clean --if-exists --single-transaction --no-owner < "$dir/db.dump"
# Тот же образ и entrypoint, что у сервиса backup (режим restore-storage), но том — на запись.
docker run --rm -v "$volume":/data -v "$PWD/docker/backup":/backup:ro -v "$dir":/restore:ro \
  --entrypoint /backup/entrypoint.sh postgres:17-alpine restore-storage
docker compose start api web
docker compose up -d --wait api web
echo "Восстановление завершено."
