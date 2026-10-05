#!/bin/sh
# Read-only пользователь для источника «Демо-база». Пароль — из env (hex, без кавычек).
set -eu
: "${DEMO_DB_PASSWORD:?задайте DEMO_DB_PASSWORD в .env}"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE ROLE demo_ro LOGIN PASSWORD '${DEMO_DB_PASSWORD}';
GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO demo_ro;
GRANT USAGE ON SCHEMA public TO demo_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO demo_ro;
-- Суперпользователь без пароля: иначе он входил бы по TCP с тем же DEMO_DB_PASSWORD, и админ
-- приложения, сменив логин источника на demo_owner, получил бы суперпользователя (COPY TO PROGRAM).
-- Локальный сокет в образе — trust (initdb, сид), pg_isready аутентификации не требует.
ALTER ROLE demo_owner PASSWORD NULL;
SQL
