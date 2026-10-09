#!/bin/sh
# Восстановление из каталога бэкапа: БД app и файлы хранилища. Останавливает api, web и агент бэкапа
# (сервис backup), очищает Redis. Аварийный путь: обычно восстановление запускается из админки («Бэкапы»).
# Хранилище — по STORAGE_BACKEND (по умолчанию s3, как у стека): s3 — бакет в сервисе s3 через сервис backup
# (rclone sync); local — том storage, только если api в compose сам работает с STORAGE_BACKEND=local:
# STORAGE_BACKEND=local scripts/restore.sh …
set -eu
dir=${1:?использование: scripts/restore.sh backups/<каталог>}
dir=$(cd "$dir" && pwd)
cd "$(dirname "$0")/.." # корень проекта compose
backend=${STORAGE_BACKEND:-s3}
case $backend in
  s3|local) ;;
  *) echo "STORAGE_BACKEND: ожидается local или s3" >&2; exit 2 ;;
esac
for f in db.dump storage.tar.gz manifest.txt; do [ -f "$dir/$f" ] || { echo "нет $dir/$f" >&2; exit 1; }; done

echo "Проверка контрольных сумм…"
for f in db.dump storage.tar.gz; do
  want=$(grep "^$f " "$dir/manifest.txt" | sed 's/.*sha256=//')
  got=$( (sha256sum "$dir/$f" 2>/dev/null || shasum -a 256 "$dir/$f") | cut -d' ' -f1)
  [ "$want" = "$got" ] || { echo "контрольная сумма $f не совпадает" >&2; exit 1; }
done

project=$(docker compose config | sed -n 's/^name: //p')
[ -n "$project" ] || { echo "не удалось прочитать конфигурацию compose — проверьте .env" >&2; exit 1; }
if [ "$backend" = local ]; then
  # Том storage читает только api в режиме local. Стек из репозитория работает с s3: восстановленные
  # в том файлы api не увидит, а база будет ссылаться на них. STORAGE_BACKEND сервиса api — из его
  # блока environment в «docker compose config» (без значения API работает в режиме local).
  api_config=$(docker compose config api)
  api_backend=$(printf '%s\n' "$api_config" |
    sed -n '/^  api:$/,/^ \{0,2\}[^ ]/s/^      STORAGE_BACKEND: *//p' | tr -d "\"'")
  if [ "${api_backend:-local}" != local ]; then
    echo "STORAGE_BACKEND=local: сервис api в compose работает с STORAGE_BACKEND=${api_backend} и том storage не читает." >&2
    echo "Восстановление в режиме local — только для установок, где api запущен с STORAGE_BACKEND=local." >&2
    echo "Для этого стека запустите без STORAGE_BACKEND (режим s3): scripts/restore.sh $dir" >&2
    exit 2
  fi
  # Полное имя тома storage этого проекта: «docker compose run -v storage:/data» compose сливает
  # с монтированием сервиса, поэтому том передаётся docker run по имени.
  volume=$(docker volume ls -q --filter "label=com.docker.compose.project=$project" \
    --filter label=com.docker.compose.volume=storage)
  [ -n "$volume" ] && [ "$(echo "$volume" | wc -l)" -eq 1 ] || {
    echo "не найден том storage проекта $project" >&2
    exit 1
  }
  target="том $volume"
else
  target="бакет S3 в сервисе s3"
fi

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

# Агент бэкапа (сервис backup: расписание и операции из админки) на время восстановления
# останавливается: он не снимет копию посреди замены файлов и не вернёт флаг обслуживания.
bk=$(docker compose ps -q --status running backup)

echo "Будут ЗАМЕНЕНЫ база app и файлы хранилища ($target) данными из $(basename "$dir")."
echo "Redis (счётчики попыток входа и флаг режима обслуживания) будет очищен."
[ -z "$bk" ] || echo "Агент бэкапа (сервис backup) будет остановлен на время восстановления."
echo "Незавершённое восстановление из админки (если есть) будет отмечено как выполненное этим скриптом."
printf 'Введите restore для продолжения: '
read -r answer || answer=
[ "$answer" = restore ] || { echo "отменено"; exit 1; }

# phase: none → stopped (api и web остановлены) → restoring (идёт замена базы) → db (база заменена)
# → storage (и хранилище) → finished.
phase=none
bk_stopped=
redis_flushed=
# Состояние в Redis (счётчики попыток входа, флаг режима обслуживания, кэши) после замены базы
# устаревает. Всё в Redis одноразовое, поэтому он очищается целиком.
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
    docker compose start backup >&2 || echo "не удалось запустить сервис backup" >&2
  fi
}
trap 'on_exit $?' EXIT
trap 'exit 130' INT TERM

if [ -n "$bk" ]; then
  docker compose stop backup
  bk_stopped=1
fi
phase=stopped
docker compose stop api web
docker compose up -d --wait postgres
# Ручной бэкап мог стартовать, пока шло подтверждение.
refuse_if_manual_backup
if [ "$backend" = s3 ]; then
  # Проверка до изменений: сервис s3 запущен, настройки backup верны, бакет читается.
  # При сбое восстановление останавливается, база не тронута.
  docker compose up -d --wait s3
  docker compose run --rm -T --no-deps --entrypoint sh backup -c \
    '[ "${STORAGE_BACKEND:-local}" = s3 ] || { echo "в сервисе backup STORAGE_BACKEND должен быть s3" >&2; exit 2; }
     . /backup/lib.sh && check_storage_backend && s3_env && rclone -q lsf --max-depth 1 "s3:$S3_BUCKET" >/dev/null'
fi
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
if [ "$backend" = local ]; then
  # Тот же entrypoint, что у сервиса backup (режим restore-storage, STORAGE_BACKEND по умолчанию local),
  # но том — на запись.
  docker run --rm -v "$volume":/data -v "$PWD/docker/backup":/backup:ro -v "$dir":/restore:ro \
    --entrypoint /backup/entrypoint.sh postgres:17-alpine restore-storage
else
  # Сервис backup: настройки S3 и сеть s3 из compose; бакет создан API при первом старте.
  # s3 и конфигурация проверены заранее (перед заменой базы).
  docker compose run --rm -T --no-deps -v "$dir":/restore:ro backup restore-storage
fi
phase=storage
# §26.4: восстановление из админки, прерванное сбоем, закрыто этим скриптом — агент после запуска
# не вернёт флаг обслуживания. Сам флаг в Redis снимает FLUSHALL ниже.
docker compose run --rm -T --no-deps --entrypoint node backup /agent/dist/main.js resolve-external || {
  echo "не удалось отметить восстановление из админки в state.json: агент может снова включить обслуживание" >&2
  exit 1
}
# api остановлен — кэш не заполнится заново старыми данными до запуска. Redis без снимков на диск,
# так что запуск (если он был остановлен) тоже даёт пустую базу, но FLUSHALL выполняется всегда.
# Пароль redis-cli берёт из REDISCLI_AUTH в окружении контейнера redis; скрипт его не читает.
if docker compose up -d --wait redis && docker compose exec -T redis redis-cli FLUSHALL; then
  redis_flushed=1
  echo "Redis очищен."
else
  echo "ВНИМАНИЕ: не удалось очистить Redis — счётчики входа и флаги в Redis могут быть устаревшими." >&2
  echo "Когда Redis заработает, выполните: $redis_hint" >&2
fi
docker compose up -d --wait api web
phase=finished
if [ -n "$bk_stopped" ]; then
  bk_stopped=
  docker compose start backup ||
    echo "не удалось запустить сервис backup: docker compose up -d backup" >&2
fi
echo "Восстановление завершено."
