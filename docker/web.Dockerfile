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

FROM nginx:1.30-alpine
COPY docker/nginx/maps.conf /etc/nginx/conf.d/00-maps.conf
COPY docker/nginx/common.conf /etc/nginx/snippets/common.conf
COPY docker/nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY docker/nginx/prod.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist/ /usr/share/nginx/html/
