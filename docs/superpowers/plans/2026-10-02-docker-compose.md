# Carbone Reports: Docker Compose для разработки и прода. План реализации

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Весь стек (nginx, api, postgres, carbone, onlyoffice) поднимается одной командой в двух режимах. Режим разработки: API с hot reload. Режим прода: собранные образы и TLS в nginx. Работоспособность доказывается smoke-скриптом на живых контейнерах.

**Architecture:** `docker-compose.yml` описывает прод. `docker-compose.dev.yml` переопределяет его для разработки. Образ API собирается многоступенчато, с target `dev` и `prod`. Образ web — это nginx с общим набором location и двумя server-конфигами (prod с TLS, dev без него). Smoke-скрипт на TypeScript проходит всю цепочку через nginx: API, Carbone, OnlyOffice и обратный вызов OnlyOffice → API.

**Tech Stack:** Docker Compose v2 (нужен `!override`, то есть версия ≥ 2.24), nginx 1.30, Node 22 (bookworm-slim), pnpm 10.34.6, PostgreSQL 17, Carbone EE 5.15.3 (Community), OnlyOffice Document Server 9.4.0.1, tsx, jszip, jose.

**Spec:** `docs/superpowers/specs/2026-10-02-carbone-reports-design.md`, §13 (и §2.1, §10).

## Global Constraints

- Образы закреплены точными тегами: `nginx:1.30-alpine`, `node:22-bookworm-slim`, `postgres:17-alpine`, `carbone/carbone-ee:full-5.15.3-fonts`, `onlyoffice/documentserver:9.4.0.1`.
- В проде наружу открыт только `web`, на `${WEB_HTTP_PORT:-80}` и `${WEB_HTTPS_PORT:-443}`. В режиме разработки дополнительно открыты `api:3000` и `postgres` на `${POSTGRES_DEV_PORT:-55433}`. Сам `web` в разработке слушает `${WEB_DEV_PORT:-8080}`.
- Обязательные переменные `APP_SECRET`, `ENCRYPTION_KEY`, `ONLYOFFICE_JWT_SECRET`, `POSTGRES_PASSWORD`, `ADMIN_LOGIN`, `ADMIN_PASSWORD` передаются только через `${VAR:?…}`, чтобы стек без них не поднимался.
- `api` получает только явно перечисленные переменные окружения, без `env_file`. Значения `DATABASE_URL`, `CARBONE_URL`, `ONLYOFFICE_INTERNAL_URL`, `API_INTERNAL_URL`, `STORAGE_DIR` собираются в compose.
- Секреты не попадают в образы и в git: `.env` и `certs/` перечислены в `.gitignore` и `.dockerignore`.
- Прод-контейнер `api` работает от пользователя `node`, без root.
- Всем сервисам задано `restart: unless-stopped`.
- Тексты для пользователя, включая JSON-ошибки nginx и страницу-заглушку, пишутся на русском.
- Каждая задача заканчивается проверкой на настоящем Docker и коммитом. Все созданные при проверке контейнеры, тома и сети удаляются (`docker compose … down -v`, если не сказано иное).

## Review Focus

1. **Нет обязательной переменной в `.env`.** Ожидание: `docker compose up` (и `config`) сразу падает и называет недостающую переменную. Тест: Task 3, шаг «проверка обязательных переменных».
2. **Данные переживают перезапуск.** Ожидание: после `docker compose restart api` и после `down` без `-v` с последующим `up` пользователи и шаблоны на месте. Тест: Task 3, шаг «перезапуск».
3. **Нестандартный порт в режиме разработки (`localhost:8080`).** Ожидание: OnlyOffice формирует ссылки с портом и подпутём `/onlyoffice`, и `fileUrl` из конвертера открывается. Тест: Task 4, шаг 5 smoke.
4. **API лежит или слишком большой запрос.** Ожидание: nginx отвечает JSON-ошибкой на русском, а не HTML-страницей. Тест: Task 2, проверки 502 и 413.
5. **Hot reload в режиме разработки.** Ожидание: правка файла в `apps/api/src` перезапускает API в контейнере без пересборки образа. Тест: Task 3, шаг «hot reload».

## Структура файлов

```
.dockerignore
.gitignore                    + certs/
.env.example                  + переменные compose
package.json                  + scripts stack:*, devDependencies tsx/jszip/jose
README.md                     + раздел «Запуск в Docker»
docker-compose.yml            прод
docker-compose.dev.yml        override разработки
docker/
  api.Dockerfile              stages: base, dev, build, prod
  web.Dockerfile              nginx + конфиги + статика
  nginx/
    maps.conf                 http-контекст: $connection_upgrade
    common.conf               location: /internal, /api, /onlyoffice, статика, JSON-ошибки
    prod.conf                 :80 → 301, :443 TLS + HSTS
    dev.conf                  :80 HTTP
  web/placeholder/index.html  заглушка (в Плане 2 заменится сборкой React)
scripts/
  dev-cert.sh                 самоподписанный сертификат в ./certs
  smoke.ts                    сквозная проверка стека
```

---

### Task 1: Образ API (`dev` и `prod`)

**Files:**
- Create: `docker/api.Dockerfile`, `.dockerignore`

**Interfaces:**
- Produces: образ с двумя target.
  - `prod`: `WORKDIR /app` содержит `dist/server.js`, `drizzle/`, `node_modules` (только prod-зависимости) и `package.json`. Команда `node dist/server.js`, пользователь `node`, порт 3000, каталог `/data` принадлежит `node`.
  - `dev`: `WORKDIR /repo`. Команда устанавливает зависимости и запускает `pnpm --filter @carbone-reports/api dev` (`tsx watch`). Исходники монтирует compose (Task 3).

- [ ] **Step 1: `.dockerignore`**

```
**/node_modules
**/dist
**/coverage
.git
.superpowers
.data
certs
.env
*.log
docs
```

- [ ] **Step 2: `docker/api.Dockerfile`**

```dockerfile
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
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @carbone-reports/api...
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @carbone-reports/api build
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm --filter @carbone-reports/api deploy --prod --legacy /out
RUN cp -r apps/api/dist apps/api/drizzle /out/

# --- Прод ---
FROM node:22-bookworm-slim AS prod
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
```

Примечания для исполнителя:
- `--filter @carbone-reports/api...` ставит только api и его workspace-зависимости. Поэтому сборка не сломается, когда в Плане 2 появится `apps/web`.
- В pnpm 10 `deploy` без `inject-workspace-packages` требует `--legacy`. Если установленная версия отвергнет флаг, используйте вариант, который она принимает (например, `inject-workspace-packages=true` в `pnpm-workspace.yaml`), и зафиксируйте это в отчёте.
- `@carbone-reports/shared` вшит в `dist` через tsup (`noExternal`). Если `deploy` всё равно скопирует shared в `node_modules`, это безвредно.
- argon2 ставится из prebuilt-бинарника под glibc. Он разрешён в `onlyBuiltDependencies`.

- [ ] **Step 3: Собрать оба target**

```bash
cd /Users/sam/carbone-reports
docker build -f docker/api.Dockerfile --target prod -t cr-api:prod .
docker build -f docker/api.Dockerfile --target dev -t cr-api:dev .
docker run --rm cr-api:prod sh -c 'id -un && ls /app && ls /app/drizzle && test -f /app/dist/server.js && node -e "require.resolve(\"argon2\")" && echo OK'
```
Expected: обе сборки успешны. Последняя команда печатает `node`, список с `dist drizzle node_modules package.json`, затем SQL-миграцию и `OK`.

- [ ] **Step 4: Прод-образ работает против настоящего PostgreSQL**

```bash
docker network create cr-t1
docker run -d --rm --name cr-t1-pg --network cr-t1 -e POSTGRES_USER=app -e POSTGRES_PASSWORD=app -e POSTGRES_DB=app postgres:17-alpine
until docker exec cr-t1-pg pg_isready -U app >/dev/null 2>&1; do sleep 1; done
docker run -d --rm --name cr-t1-api --network cr-t1 -p 3999:3000 \
  -e DATABASE_URL=postgres://app:app@cr-t1-pg:5432/app \
  -e APP_SECRET=$(openssl rand -hex 32) -e ENCRYPTION_KEY=$(openssl rand -base64 32) \
  -e ONLYOFFICE_JWT_SECRET=$(openssl rand -hex 32) -e ADMIN_LOGIN=admin -e ADMIN_PASSWORD=admin12345 \
  -e STORAGE_DIR=/data cr-api:prod
until curl -sf localhost:3999/api/health >/dev/null; do sleep 1; done
curl -s localhost:3999/api/health
curl -s -c /tmp/cr-t1.cookies -H 'content-type: application/json' -d '{"login":"admin","password":"admin12345"}' localhost:3999/api/auth/login
docker exec cr-t1-api sh -c 'touch /data/probe && echo WRITABLE'
docker stop cr-t1-api cr-t1-pg; docker network rm cr-t1
```
Expected: `{"status":"ok"}`, JSON админа (`"role":"admin"`), `WRITABLE`. Если контейнер упал, смотрите `docker logs cr-t1-api` до остановки.

- [ ] **Step 5: Commit**

```bash
git add .dockerignore docker/api.Dockerfile
git commit -m "build(docker): api image with dev and prod targets"
```

---

### Task 2: Образ web (nginx, заглушка, TLS)

**Files:**
- Create: `docker/web.Dockerfile`, `docker/nginx/maps.conf`, `docker/nginx/common.conf`, `docker/nginx/prod.conf`, `docker/nginx/dev.conf`, `docker/web/placeholder/index.html`, `scripts/dev-cert.sh`
- Modify: `.gitignore` (+ `certs/`)

**Interfaces:**
- Produces: образ nginx.
  - `/etc/nginx/conf.d/default.conf` = `prod.conf`. Compose в режиме разработки подменяет его на `dev.conf`.
  - `/etc/nginx/snippets/common.conf`.
  - `/etc/nginx/conf.d/00-maps.conf`.
  - Статика лежит в `/usr/share/nginx/html`.
  - Сертификаты ожидаются в `/etc/nginx/certs/{fullchain,privkey}.pem`.
  - Апстримы: `api:3000` и `onlyoffice:80`.

- [ ] **Step 1: Конфиги nginx**

`docker/nginx/maps.conf`:
```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
```

`docker/nginx/common.conf`:
```nginx
root /usr/share/nginx/html;

# Маршруты для Document Server доступны только во внутренней сети.
location = /internal { return 404; }
location /internal/ { return 404; }

location /api/ {
    proxy_pass http://api:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    client_max_body_size 25m;
    proxy_read_timeout 180s;
    proxy_send_timeout 180s;
    proxy_intercept_errors off;
    error_page 502 503 504 = @api_unavailable;
    error_page 413 = @too_large;
}

location /onlyoffice/ {
    proxy_pass http://onlyoffice/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header X-Forwarded-Host $http_host/onlyoffice;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    # Сессия админа не должна уходить в Document Server.
    proxy_set_header Cookie "";
    client_max_body_size 100m;
    proxy_read_timeout 300s;
}

location @api_unavailable {
    default_type application/json;
    return 503 '{"error":{"code":"SERVICE_UNAVAILABLE","message":"сервис временно недоступен"}}';
}

location @too_large {
    default_type application/json;
    return 413 '{"error":{"code":"PAYLOAD_TOO_LARGE","message":"тело запроса слишком большое"}}';
}

location / {
    try_files $uri /index.html;
}
```

`docker/nginx/prod.conf`:
```nginx
server {
    listen 80;
    server_name _;
    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl;
    http2 on;
    server_name _;

    ssl_certificate     /etc/nginx/certs/fullchain.pem;
    ssl_certificate_key /etc/nginx/certs/privkey.pem;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_session_cache   shared:SSL:10m;

    add_header Strict-Transport-Security "max-age=31536000" always;

    include /etc/nginx/snippets/common.conf;
}
```

`docker/nginx/dev.conf`:
```nginx
server {
    listen 80;
    server_name _;
    include /etc/nginx/snippets/common.conf;
}
```

Примечание: `error_page 502 = @api_unavailable` срабатывает, когда nginx не может достучаться до `api`. Ответы самого API (включая его 502 `DATASOURCE_UNAVAILABLE` и 504 `TIMEOUT`) проходят без изменений, потому что `proxy_intercept_errors off`. Проверьте это (Step 4). Если nginx всё же подменяет ответы API, перенесите обработку недоступности в `proxy_next_upstream`/`@api_unavailable` только для ошибок соединения и опишите решение в отчёте.

- [ ] **Step 2: Заглушка, Dockerfile, сертификаты**

`docker/web/placeholder/index.html`:
```html
<!doctype html>
<html lang="ru">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Carbone Reports</title>
    <style>
      body { font-family: system-ui, sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f6f7f9; color: #1f2329; }
      main { max-width: 32rem; padding: 2rem; text-align: center; }
      h1 { font-size: 1.5rem; margin: 0 0 0.5rem; }
      p { color: #5c6370; line-height: 1.5; }
      code { background: #e9ebef; padding: 0.1rem 0.35rem; border-radius: 4px; }
    </style>
  </head>
  <body>
    <main>
      <h1>Carbone Reports</h1>
      <p>Интерфейс ещё в разработке. API доступен по адресу <code>/api</code>.</p>
      <p id="status">Проверяем API…</p>
    </main>
    <script>
      fetch('/api/health')
        .then((r) => r.json())
        .then((b) => { document.getElementById('status').textContent = b.status === 'ok' ? 'API работает.' : 'API отвечает с ошибкой.'; })
        .catch(() => { document.getElementById('status').textContent = 'API недоступен.'; });
    </script>
  </body>
</html>
```

`docker/web.Dockerfile`:
```dockerfile
FROM nginx:1.30-alpine
COPY docker/nginx/maps.conf /etc/nginx/conf.d/00-maps.conf
COPY docker/nginx/common.conf /etc/nginx/snippets/common.conf
COPY docker/nginx/prod.conf /etc/nginx/conf.d/default.conf
COPY docker/web/placeholder/ /usr/share/nginx/html/
```

`scripts/dev-cert.sh`:
```sh
#!/usr/bin/env sh
# Самоподписанный сертификат для локальной проверки прод-режима. Не для боевого использования.
set -eu
cd "$(dirname "$0")/.."
mkdir -p certs
openssl req -x509 -newkey rsa:2048 -nodes -days 365 \
  -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" \
  -keyout certs/privkey.pem -out certs/fullchain.pem
echo "Сертификат создан: certs/fullchain.pem, certs/privkey.pem"
```
`chmod +x scripts/dev-cert.sh`. В `.gitignore` добавить строку `certs/`.

- [ ] **Step 3: Проверить конфиги**

Для проверки апстримы подменяются: `api` указывает на контейнер-заглушку, который на любой запрос отвечает 200 `{"status":"ok"}`, а `onlyoffice` указывает на 127.0.0.1.

```bash
./scripts/dev-cert.sh
docker build -f docker/web.Dockerfile -t cr-web:test .
docker run --rm -v "$PWD/certs:/etc/nginx/certs:ro" --add-host api:127.0.0.1 --add-host onlyoffice:127.0.0.1 cr-web:test nginx -t
docker run --rm -v "$PWD/docker/nginx/dev.conf:/etc/nginx/conf.d/default.conf:ro" --add-host api:127.0.0.1 --add-host onlyoffice:127.0.0.1 cr-web:test nginx -t
```
Expected: дважды `syntax is ok` / `test is successful`.

- [ ] **Step 4: Поведение маршрутов на живом nginx**

```bash
docker network create cr-t2
docker run -d --rm --name cr-t2-api --network cr-t2 --network-alias api node:22-bookworm-slim \
  node -e "require('http').createServer((q,s)=>{if(q.url.startsWith('/api/big')){let n=0;q.on('data',c=>n+=c.length);q.on('end',()=>{s.end(JSON.stringify({n}))});return}s.setHeader('content-type','application/json');if(q.url==='/api/fail'){s.statusCode=502;return s.end('{\"error\":{\"code\":\"DATASOURCE_UNAVAILABLE\",\"message\":\"x\"}}')}s.end('{\"status\":\"ok\"}')}).listen(3000)"
docker run -d --rm --name cr-t2-oo --network cr-t2 --network-alias onlyoffice nginx:1.30-alpine
docker run -d --rm --name cr-t2-web --network cr-t2 -p 8443:443 -p 8081:80 -v "$PWD/certs:/etc/nginx/certs:ro" cr-web:test
sleep 2
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' http://localhost:8081/api/health      # 301 https://localhost/api/health
curl -sk https://localhost:8443/api/health                                                     # {"status":"ok"}
curl -sk -o /dev/null -w '%{http_code}\n' https://localhost:8443/internal/templates/x/file     # 404
curl -sk --path-as-is -o /dev/null -w '%{http_code}\n' "https://localhost:8443/api/../internal/x"            # 404
curl -sk https://localhost:8443/some/spa/route | grep -c 'Carbone Reports'                       # 1
curl -sk -I https://localhost:8443/ | grep -i strict-transport                                   # HSTS
curl -sk https://localhost:8443/api/fail                                                         # ответ API как есть: DATASOURCE_UNAVAILABLE
head -c 26214500 /dev/zero > /tmp/cr-big.bin
curl -sk -X POST --data-binary @/tmp/cr-big.bin -H 'content-type: application/octet-stream' https://localhost:8443/api/big   # 413 JSON «тело запроса слишком большое»
curl -sk -o /dev/null -w '%{http_code}\n' https://localhost:8443/onlyoffice/                  # 200 (стартовая страница nginx-заглушки)
docker stop cr-t2-api
curl -sk https://localhost:8443/api/health                                                       # 503 JSON «сервис временно недоступен»
docker stop cr-t2-web cr-t2-oo; docker network rm cr-t2; rm -f /tmp/cr-big.bin
```
Expected: значения указаны в комментариях. Если `/api/fail` превращается в ответ `@api_unavailable`, это ошибка (см. примечание к Step 1): исправьте и перепроверьте.

- [ ] **Step 5: Commit**

```bash
git add docker/web.Dockerfile docker/nginx docker/web scripts/dev-cert.sh .gitignore
git commit -m "build(docker): nginx web image with TLS, proxy routes and placeholder"
```

---

### Task 3: Compose-файлы, переменные окружения, команды, документация

**Files:**
- Create: `docker-compose.yml`, `docker-compose.dev.yml`
- Modify: `.env.example`, `package.json` (scripts), `README.md`

**Interfaces:**
- Consumes: образы из Task 1 и Task 2.
- Produces:
  - сервисы `web`, `api`, `postgres`, `carbone`, `onlyoffice`;
  - тома `storage`, `pgdata`, `carbone_templates`, `oo_data`, `oo_lib`, `oo_logs`, а в режиме разработки ещё `dev_node_modules`, `dev_api_node_modules`, `dev_shared_node_modules`, `dev_pnpm_store`;
  - команды `pnpm stack:prod`, `pnpm stack:dev`, `pnpm stack:down`, `pnpm stack:smoke` (сам скрипт пишется в Task 4).

- [ ] **Step 1: `docker-compose.yml`**

```yaml
name: carbone-reports

services:
  web:
    build:
      context: .
      dockerfile: docker/web.Dockerfile
    ports:
      - "${WEB_HTTP_PORT:-80}:80"
      - "${WEB_HTTPS_PORT:-443}:443"
    volumes:
      - ./certs:/etc/nginx/certs:ro
    depends_on:
      api:
        condition: service_healthy
      onlyoffice:
        condition: service_started
    restart: unless-stopped

  api:
    build:
      context: .
      dockerfile: docker/api.Dockerfile
      target: prod
    environment:
      DATABASE_URL: postgres://app:${POSTGRES_PASSWORD:?задайте POSTGRES_PASSWORD в .env}@postgres:5432/app
      APP_SECRET: ${APP_SECRET:?задайте APP_SECRET в .env}
      ENCRYPTION_KEY: ${ENCRYPTION_KEY:?задайте ENCRYPTION_KEY в .env}
      ONLYOFFICE_JWT_SECRET: ${ONLYOFFICE_JWT_SECRET:?задайте ONLYOFFICE_JWT_SECRET в .env}
      ADMIN_LOGIN: ${ADMIN_LOGIN:?задайте ADMIN_LOGIN в .env}
      ADMIN_PASSWORD: ${ADMIN_PASSWORD:?задайте ADMIN_PASSWORD в .env}
      ONLYOFFICE_INTERNAL_URL: http://onlyoffice
      API_INTERNAL_URL: http://api:3000
      CARBONE_URL: http://carbone:4000
      STORAGE_DIR: /data
      COOKIE_SECURE: "true"
      TZ: ${TZ:-Europe/Moscow}
      QUERY_TIMEOUT_MS: ${QUERY_TIMEOUT_MS:-30000}
      QUERY_MAX_ROWS: ${QUERY_MAX_ROWS:-100000}
      RENDER_TIMEOUT_MS: ${RENDER_TIMEOUT_MS:-120000}
      REPORT_RETENTION_DAYS: ${REPORT_RETENTION_DAYS:-30}
    volumes:
      - storage:/data
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 10s
      timeout: 5s
      retries: 6
      start_period: 30s
    depends_on:
      postgres:
        condition: service_healthy
      carbone:
        condition: service_started
    restart: unless-stopped

  postgres:
    image: postgres:17-alpine
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?задайте POSTGRES_PASSWORD в .env}
      POSTGRES_DB: app
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app -d app"]
      interval: 5s
      timeout: 3s
      retries: 20
    restart: unless-stopped

  carbone:
    image: carbone/carbone-ee:full-5.15.3-fonts
    volumes:
      - carbone_templates:/app/template
    restart: unless-stopped

  onlyoffice:
    image: onlyoffice/documentserver:9.4.0.1
    environment:
      JWT_ENABLED: "true"
      JWT_SECRET: ${ONLYOFFICE_JWT_SECRET:?задайте ONLYOFFICE_JWT_SECRET в .env}
      JWT_HEADER: Authorization
      ALLOW_PRIVATE_IP_ADDRESS: "true"
    volumes:
      - oo_data:/var/www/onlyoffice/Data
      - oo_lib:/var/lib/onlyoffice
      - oo_logs:/var/log/onlyoffice
    restart: unless-stopped

volumes:
  storage:
  pgdata:
  carbone_templates:
  oo_data:
  oo_lib:
  oo_logs:
```

Примечания для исполнителя:
- **Healthcheck Carbone.** Проверьте, что есть в образе: `docker run --rm --entrypoint sh carbone/carbone-ee:full-5.15.3-fonts -c 'command -v curl wget node; echo'`. Если есть `curl` или `wget`, добавьте сервису `carbone` healthcheck на `GET http://127.0.0.1:4000/status` и поменяйте `depends_on.carbone.condition` на `service_healthy`. Если ничего нет, оставьте как есть и запишите это в отчёт.
- **Порт Carbone.** Убедитесь, что Carbone слушает `0.0.0.0:4000` внутри контейнера, то есть `api` до него достучится. Это проверит Task 4. Если не слушает, задайте `CARBONE_BIND: 0.0.0.0`.

- [ ] **Step 2: `docker-compose.dev.yml`**

```yaml
services:
  web:
    ports: !override
      - "${WEB_DEV_PORT:-8080}:80"
    volumes: !override
      - ./docker/nginx/dev.conf:/etc/nginx/conf.d/default.conf:ro

  api:
    build:
      target: dev
    working_dir: /repo
    environment:
      COOKIE_SECURE: "false"
    ports:
      - "3000:3000"
    volumes:
      - .:/repo
      - dev_node_modules:/repo/node_modules
      - dev_api_node_modules:/repo/apps/api/node_modules
      - dev_shared_node_modules:/repo/packages/shared/node_modules
      - dev_pnpm_store:/pnpm/store
    healthcheck:
      start_period: 240s

  postgres:
    ports:
      - "${POSTGRES_DEV_PORT:-55433}:5432"

volumes:
  dev_node_modules:
  dev_api_node_modules:
  dev_shared_node_modules:
  dev_pnpm_store:
```

- [ ] **Step 3: `.env.example`, scripts, README**

К существующему `.env.example` добавить блок в начале (существующие переменные оставить: они нужны для запуска API на хосте без Docker):
```dotenv
# ---- Docker Compose (docker compose up / pnpm stack:*) ----
# Обязательные. Сгенерировать: openssl rand -hex 32 / openssl rand -base64 32
POSTGRES_PASSWORD=
# Порты прод-режима
WEB_HTTP_PORT=80
WEB_HTTPS_PORT=443
# Порты режима разработки
WEB_DEV_PORT=8080
POSTGRES_DEV_PORT=55433
# APP_SECRET, ENCRYPTION_KEY, ONLYOFFICE_JWT_SECRET, ADMIN_LOGIN, ADMIN_PASSWORD — см. ниже, тоже обязательны.
# DATABASE_URL, STORAGE_DIR, *_URL в Docker задаёт docker-compose.yml; значения ниже — для запуска API на хосте.
```

Корневой `package.json`, добавить в `scripts`:
```json
"stack:prod": "docker compose up -d --build",
"stack:dev": "docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build",
"stack:down": "docker compose -f docker-compose.yml -f docker-compose.dev.yml down",
"stack:smoke": "tsx scripts/smoke.ts"
```

`README.md`, новый раздел «Запуск в Docker» после «Разработка API»:
````markdown
## Запуск в Docker

Нужен Docker с Compose v2.24+. Первый запуск скачивает образы OnlyOffice и Carbone (несколько ГБ).

```bash
cp .env.example .env      # заполнить обязательные переменные
```

**Разработка** (API с hot reload, интерфейс на http://localhost:8080, API напрямую на :3000, PostgreSQL на :55433):

```bash
pnpm stack:dev
```

**Прод** (HTTPS в nginx; положите сертификат и ключ в `certs/fullchain.pem` и `certs/privkey.pem`;
для локальной проверки — `./scripts/dev-cert.sh`):

```bash
pnpm stack:prod
```

**Проверка работающего стека:**

```bash
pnpm stack:smoke                                        # разработка, http://localhost:8080
BASE_URL=https://localhost pnpm stack:smoke --insecure  # прод с самоподписанным сертификатом
```

Остановить: `pnpm stack:down` (данные сохраняются в томах; `docker compose down -v` удалит их).

Наружу в проде открыт только nginx. Маршруты `/internal/*` закрыты: их вызывает только OnlyOffice внутри сети.
Сессионная cookie в проде помечена `Secure`, поэтому интерфейс работает только по HTTPS.
````

- [ ] **Step 4: Проверка обязательных переменных**

```bash
mv .env .env.bak 2>/dev/null; true
docker compose config >/dev/null; echo "exit=$?"
docker compose -f docker-compose.yml -f docker-compose.dev.yml config >/dev/null; echo "exit=$?"
mv .env.bak .env 2>/dev/null; true
```
Expected: оба раза `exit` ≠ 0, и в выводе есть «задайте … в .env».

- [ ] **Step 5: Поднять прод-стек**

Создать `.env` для проверки. Если файл уже есть, сохраните его как `.env.bak` и потом верните:
```bash
cat > .env <<EOF
POSTGRES_PASSWORD=$(openssl rand -hex 16)
APP_SECRET=$(openssl rand -hex 32)
ENCRYPTION_KEY=$(openssl rand -base64 32)
ONLYOFFICE_JWT_SECRET=$(openssl rand -hex 32)
ADMIN_LOGIN=admin
ADMIN_PASSWORD=admin12345
WEB_HTTP_PORT=8088
WEB_HTTPS_PORT=8443
EOF
./scripts/dev-cert.sh
docker compose config --quiet && echo CONFIG_OK
docker compose up -d --build
docker compose ps
until curl -sk https://localhost:8443/api/health | grep -q ok; do sleep 3; done
curl -sk https://localhost:8443/api/health
curl -sk -c /tmp/cr.cookies -H 'content-type: application/json' -d '{"login":"admin","password":"admin12345"}' https://localhost:8443/api/auth/login
curl -sk -o /dev/null -w '%{http_code}\n' https://localhost:8443/onlyoffice/healthcheck
docker compose port api 3000 || echo "api не опубликован — OK"
```
Expected: `CONFIG_OK`. Все сервисы `running`, `api` и `postgres` в состоянии `healthy`. Health отвечает ok, вход возвращает админа, `/onlyoffice/healthcheck` → 200 (OnlyOffice стартует 1–2 минуты, повторите). Порт `api` не опубликован.

- [ ] **Step 6: Перезапуск сохраняет данные**

```bash
curl -sk -b /tmp/cr.cookies -H 'content-type: application/json' -d '{"login":"persist_check","password":"password123","role":"user"}' https://localhost:8443/api/users
docker compose restart api
until curl -sk https://localhost:8443/api/health | grep -q ok; do sleep 2; done
docker compose down
docker compose up -d
until curl -sk https://localhost:8443/api/health | grep -q ok; do sleep 3; done
curl -sk -H 'content-type: application/json' -d '{"login":"persist_check","password":"password123"}' https://localhost:8443/api/auth/login
docker compose down -v
```
Expected: после `restart` и после `down`/`up` пользователь `persist_check` может войти.

- [ ] **Step 7: Режим разработки и hot reload**

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
until curl -sf localhost:8080/api/health | grep -q ok; do sleep 3; done
curl -s localhost:8080/api/health; curl -s localhost:3000/api/health
docker compose -f docker-compose.yml -f docker-compose.dev.yml exec postgres pg_isready -U app
echo "// hot-reload probe" >> apps/api/src/app.ts
sleep 5
docker compose -f docker-compose.yml -f docker-compose.dev.yml logs api --since 15s | grep -iE "restart|change|listening|Server listening" || true
git checkout apps/api/src/app.ts
until curl -sf localhost:8080/api/health | grep -q ok; do sleep 2; done && echo AFTER_RELOAD_OK
ls apps/api/node_modules 2>/dev/null | head -1; echo "(хост node_modules не тронут)"
```
Expected: health отвечает на обоих портах. В логах после правки виден перезапуск tsx watch, затем `AFTER_RELOAD_OK`. Если события файловой системы не доходят до контейнера (на macOS бывает), добавьте в dev-команду переменную `CHOKIDAR_USEPOLLING=1` или найдите аналог у tsx и отразите это в отчёте. Hot reload обязателен.

Остановить, оставив `.env` и `certs/` для Task 4:
```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml down
```

- [ ] **Step 8: Commit**

```bash
git add docker-compose.yml docker-compose.dev.yml .env.example package.json README.md
git commit -m "build(docker): compose stacks for development and production"
```

---

### Task 4: Smoke-проверка живого стека

**Files:**
- Create: `scripts/smoke.ts`, `scripts/tsconfig.json`
- Modify: корневой `package.json` (devDependencies `tsx`, `jszip`, `jose`, `@types/node`), `tsconfig`/eslint (подключить `scripts/`, если lint/typecheck этого требуют)

**Interfaces:**
- Consumes: работающий стек (Task 3), `.env` (читается через `process.loadEnvFile`).
- Produces: `pnpm stack:smoke [--insecure]`, `BASE_URL` (по умолчанию `http://localhost:8080`). Каждая проверка печатает `✓`/`✗` и время выполнения. Код выхода: 0, если все проверки прошли, иначе 1.

- [ ] **Step 1: Зависимости**

```bash
pnpm add -Dw tsx@^4.23.15 jszip@^3.10.2 jose@^6.2.12 @types/node@^22.20.5
```

- [ ] **Step 2: `scripts/smoke.ts`**

```ts
// Сквозная проверка работающего стека через nginx. Запуск: pnpm stack:smoke [--insecure]
import { randomUUID } from 'node:crypto';
import JSZip from 'jszip';
import { SignJWT } from 'jose';

if (process.argv.includes('--insecure')) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
try {
  process.loadEnvFile('.env');
} catch {
  // .env может отсутствовать, если переменные заданы окружением
}

const BASE = (process.env.BASE_URL ?? 'http://localhost:8080').replace(/\/$/, '');
const need = (k: string) => {
  const v = process.env[k];
  if (!v) throw new Error(`не задана переменная ${k}`);
  return v;
};

let cookie = '';
let failed = 0;
const cleanup: (() => Promise<unknown>)[] = [];

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (cookie) headers.set('cookie', cookie);
  return fetch(`${BASE}${path}`, { ...init, headers, redirect: 'manual' });
}

async function json<T = unknown>(res: Response, expected = 200): Promise<T> {
  const text = await res.text();
  if (res.status !== expected) throw new Error(`HTTP ${res.status}, ожидался ${expected}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  const t = Date.now();
  try {
    await fn();
    console.log(`✓ ${name} (${Date.now() - t} мс)`);
  } catch (e) {
    failed++;
    console.log(`✗ ${name}: ${(e as Error).message}`);
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function docxWithTag(): Promise<Buffer> {
  const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file('_rels/.rels', `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file('word/document.xml', `${XML}<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Компания: {d.company.name}</w:t></w:r></w:p></w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function main() {
  console.log(`Smoke-проверка ${BASE}`);
  let templateId = '';
  let datasourceId = '';

  await step('health через nginx', async () => {
    const b = await json<{ status: string }>(await api('/api/health'));
    assert(b.status === 'ok', `status=${b.status}`);
  });

  await step('/internal закрыт снаружи', async () => {
    const r = await api('/internal/templates/00000000-0000-0000-0000-000000000000/file');
    assert(r.status === 404, `HTTP ${r.status}`);
  });

  await step('вход админа', async () => {
    const r = await api('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: need('ADMIN_LOGIN'), password: need('ADMIN_PASSWORD') }),
    });
    await json(r);
    cookie = (r.headers.get('set-cookie') ?? '').split(';')[0]!;
    assert(cookie.startsWith('session='), 'нет cookie session');
  });

  await step('источник данных на postgres', async () => {
    const ds = await json<{ id: string }>(
      await api('/api/datasources', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: `smoke ${randomUUID().slice(0, 6)}`,
          host: 'postgres',
          port: 5432,
          database: 'app',
          username: 'app',
          password: need('POSTGRES_PASSWORD'),
          ssl: false,
        }),
      }),
      201,
    );
    datasourceId = ds.id;
    cleanup.push(() => api(`/api/datasources/${datasourceId}`, { method: 'DELETE' }));
    const test = await json<{ ok: boolean; message?: string }>(await api(`/api/datasources/${datasourceId}/test`, { method: 'POST' }));
    assert(test.ok, `проверка соединения: ${test.message}`);
  });

  await step('загрузка шаблона и запрос', async () => {
    const form = new FormData();
    form.append('name', 'Smoke-шаблон');
    form.append('description', '');
    form.append('datasourceId', datasourceId);
    form.append('file', new Blob([new Uint8Array(await docxWithTag())]), 'smoke.docx');
    const t = await json<{ id: string }>(await api('/api/templates/upload', { method: 'POST', body: form }), 201);
    templateId = t.id;
    cleanup.unshift(() => api(`/api/templates/${templateId}`, { method: 'DELETE' }));
    await json(
      await api(`/api/templates/${templateId}/queries`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify([{ key: 'company', mode: 'single', sql: "select 'ООО Ромашка' as name" }]),
      }),
    );
  });

  async function renderTo(format: 'pdf' | 'docx'): Promise<Buffer> {
    const { runId } = await json<{ runId: string }>(
      await api(`/api/reports/${templateId}/render`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ params: {}, format }),
      }),
      201,
    );
    const r = await api(`/api/runs/${runId}/file`);
    assert(r.status === 200, `скачивание: HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }

  await step('Carbone: DOCX с подставленными данными', async () => {
    const zip = await JSZip.loadAsync(await renderTo('docx'));
    const xml = await zip.file('word/document.xml')!.async('string');
    assert(xml.includes('ООО Ромашка'), 'в документе нет «ООО Ромашка»');
    assert(!xml.includes('{d.company.name}'), 'тег не заменён');
  });

  await step('Carbone: PDF', async () => {
    const pdf = await renderTo('pdf');
    assert(pdf.subarray(0, 4).toString() === '%PDF', 'файл не PDF');
  });

  await step('OnlyOffice: healthcheck и api.js через nginx', async () => {
    const h = await api('/onlyoffice/healthcheck');
    assert(h.status === 200 && (await h.text()).trim() === 'true', `healthcheck HTTP ${h.status}`);
    const js = await api('/onlyoffice/web-apps/apps/api/documents/api.js');
    assert(js.status === 200, `api.js HTTP ${js.status}`);
  });

  await step('OnlyOffice → api: конвертация шаблона по внутреннему URL', async () => {
    const cfg = await json<{ document: { url: string } }>(await api(`/api/templates/${templateId}/editor-config`));
    const body = {
      async: false,
      filetype: 'docx',
      outputtype: 'pdf',
      key: randomUUID().replaceAll('-', ''),
      title: 'smoke.docx',
      url: cfg.document.url,
    };
    const secret = new TextEncoder().encode(need('ONLYOFFICE_JWT_SECRET'));
    const token = await new SignJWT(body).setProtectedHeader({ alg: 'HS256', typ: 'JWT' }).sign(secret);
    const r = await fetch(`${BASE}/onlyoffice/converter`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ ...body, token }),
    });
    const res = (await r.json()) as { endConvert?: boolean; fileUrl?: string; error?: number };
    assert(res.endConvert && res.fileUrl, `ответ конвертера: ${JSON.stringify(res)}`);
    const file = await fetch(res.fileUrl);
    assert(file.status === 200, `fileUrl ${res.fileUrl}: HTTP ${file.status}`);
    assert(Buffer.from(await file.arrayBuffer()).subarray(0, 4).toString() === '%PDF', 'результат конвертации не PDF');
  });

  for (const fn of cleanup) {
    await fn().catch(() => undefined);
  }

  console.log(failed === 0 ? '\nВсе проверки пройдены.' : `\nПровалено проверок: ${failed}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

`scripts/tsconfig.json`:
```json
{ "extends": "../tsconfig.base.json", "include": ["*.ts"] }
```
Добавить в корневой `package.json` в `scripts` команду `"typecheck:scripts": "tsc -p scripts/tsconfig.json"` и включить её в общий `typecheck`: `"typecheck": "pnpm -r typecheck && pnpm typecheck:scripts"`.

- [ ] **Step 3: Прогон против режима разработки**

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build
until curl -sf localhost:8080/api/health | grep -q ok; do sleep 3; done
until curl -sf localhost:8080/onlyoffice/healthcheck | grep -q true; do sleep 5; done
pnpm stack:smoke
```
Expected: все 9 проверок `✓`, код выхода 0.

Если проверка падает, исправляйте инфраструктуру, а не ослабляйте проверку. Вероятные места:
- **Конвертер OnlyOffice.** Если путь `/converter` недоступен в 9.4, используйте `/ConvertService.ashx` и отразите это в отчёте. Если не приходит JWT, проверьте, что `JWT_SECRET` совпадает.
- **`fileUrl` ведёт не на `BASE/onlyoffice/…`.** Неверен `X-Forwarded-Host` в `common.conf`. Сверьтесь с документацией OnlyOffice «Using Docs behind the proxy with virtual path».
- **Document Server не может скачать файл с `http://api:3000`.** Проверьте `ALLOW_PRIVATE_IP_ADDRESS` (`docker compose exec onlyoffice cat /etc/onlyoffice/documentserver/local.json`).
- **Ошибки Carbone.** Смотрите `docker compose logs carbone api`. Если формат ответа Carbone 5 отличается от ожиданий `apps/api/src/modules/carbone/client.ts`, исправьте клиент вместе с его юнит-тестами отдельным коммитом `fix(api): …`.

Каждую найденную и исправленную проблему опишите в отчёте.

- [ ] **Step 4: Прогон против прод-режима**

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml down
docker compose up -d --build
until curl -sk https://localhost:8443/api/health | grep -q ok; do sleep 3; done
until curl -sk https://localhost:8443/onlyoffice/healthcheck | grep -q true; do sleep 5; done
BASE_URL=https://localhost:8443 pnpm stack:smoke --insecure
docker compose down -v
```
Expected: все проверки `✓`, код выхода 0.

- [ ] **Step 5: Гейты и commit**

```bash
pnpm typecheck && pnpm lint && pnpm exec prettier --check .
pnpm test
git add scripts/smoke.ts scripts/tsconfig.json package.json pnpm-lock.yaml
git commit -m "test(docker): end-to-end smoke check of the running stack"
```
Перед коммитом убедитесь, что `.env` и `certs/` не попали в индекс (`git status`).
