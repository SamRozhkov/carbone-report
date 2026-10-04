# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN corepack enable && corepack prepare pnpm@10.34.6 --activate
RUN pnpm config set store-dir /pnpm/store

# --- Разработка: исходники монтируются томом, зависимости ставятся при старте контейнера ---
FROM base AS dev
WORKDIR /repo
EXPOSE 3000
CMD ["sh", "-c", "pnpm install --frozen-lockfile --filter @carbone-reports/api... && pnpm --filter @carbone-reports/api dev"]

# --- Сборка ---
FROM base AS build
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @carbone-reports/api...
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @carbone-reports/api build
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm --filter @carbone-reports/api deploy --prod --legacy /out
RUN cp -r apps/api/dist apps/api/drizzle /out/
RUN rm -rf /out/src /out/test

# --- Прод ---
FROM node:22-bookworm-slim AS prod
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
