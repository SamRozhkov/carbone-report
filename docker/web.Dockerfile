# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN corepack enable && corepack prepare pnpm@10.34.6 --activate
RUN pnpm config set store-dir /pnpm/store
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/web/package.json apps/web/
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @carbone-reports/web...
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @carbone-reports/web build

# Конфигурация nginx без SPA (стадию собирает тест apps/web/test/nginx.int.test.ts).
FROM nginx:1.30-alpine AS nginx
# common.conf — шаблон envsubst: подставляются только эти переменные, $host и прочие переменные nginx не трогаются.
ENV NGINX_MODE=tls \
    API_UPSTREAM=http://api:3000 \
    ONLYOFFICE_UPSTREAM=http://onlyoffice \
    NGINX_ENVSUBST_OUTPUT_DIR=/etc/nginx/snippets \
    NGINX_ENVSUBST_FILTER='^(NGINX_RESOLVER|API_UPSTREAM|ONLYOFFICE_UPSTREAM)$'
COPY docker/nginx/maps.conf /etc/nginx/conf.d/00-maps.conf
COPY docker/nginx/templates/ /etc/nginx/templates/
COPY docker/nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY docker/nginx/server-tls.conf docker/nginx/server-http.conf docker/nginx/server-dev.conf /etc/nginx/modes/
COPY --chmod=755 docker/nginx/15-carbone-reports.envsh /docker-entrypoint.d/15-carbone-reports.envsh

FROM nginx
COPY --from=build /repo/apps/web/dist/ /usr/share/nginx/html/
