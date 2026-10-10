# Образ сервиса backup: агент бэкапа (apps/backup-agent, Node) и скрипты docker/backup поверх
# postgres:17-alpine (pg_dump той же мажорной версии, что у сервера) с rclone (STORAGE_BACKEND=s3).
# Контекст сборки — корень репозитория: в образ входят агент и миграции apps/api/drizzle того же
# коммита — по ним агент проверяет версию схемы бэкапа и доводит восстановленную базу до текущей.
# Без BuildKit-only инструкций: образ собирается и классическим сборщиком (testcontainers).

# --- Сборка агента (тот же базовый образ, что у api) ---
FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN corepack enable && corepack prepare pnpm@10.34.6 --activate
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/backup-agent/package.json apps/backup-agent/
COPY packages/shared/package.json packages/shared/
COPY packages/carbone/package.json packages/carbone/
RUN pnpm install --frozen-lockfile --filter @carbone-reports/backup-agent...
COPY apps/backup-agent apps/backup-agent
RUN pnpm --filter @carbone-reports/backup-agent build
# Зависимости агента — чистый JS: node_modules этого этапа (glibc) работают и на alpine (musl).
RUN pnpm --filter @carbone-reports/backup-agent deploy --prod --legacy /out \
 && cp -r apps/backup-agent/dist /out/ \
 && rm -rf /out/src /out/test

# --- Образ ---
FROM postgres:17-alpine
RUN apk add --no-cache rclone nodejs
COPY docker/backup/entrypoint.sh docker/backup/backup.sh docker/backup/archive-storage.sh docker/backup/lib.sh /backup/
RUN chmod 755 /backup/*.sh
COPY --from=build /out /agent
COPY apps/api/drizzle /agent/drizzle
COPY LICENSE.md NOTICE.md /agent/
# Версия сборки: CI передаёт build-args; без них образ — dev. В конце стадии, чтобы новый коммит не сбрасывал кэш слоёв выше.
ARG APP_VERSION=dev
ARG APP_COMMIT=unknown
ARG APP_BUILD_DATE=unknown
ENV APP_VERSION=$APP_VERSION \
    APP_COMMIT=$APP_COMMIT \
    APP_BUILD_DATE=$APP_BUILD_DATE
ENTRYPOINT ["/backup/entrypoint.sh"]
CMD ["agent"]
