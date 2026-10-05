# Carbone Reports

Генерация отчётов на базе Carbone с редактированием шаблонов в браузере (OnlyOffice) и интерфейсом на GravityUI.

[![CI](https://github.com/SamRozhkov/carbone-report/actions/workflows/ci.yml/badge.svg)](https://github.com/SamRozhkov/carbone-report/actions/workflows/ci.yml)

Спецификация: `docs/superpowers/specs/2026-10-02-carbone-reports-design.md`.

## Разработка API

Требования: Node 22 (`nvm use`), pnpm 10 (`corepack enable`), запущенный Docker (для интеграционных тестов).

```bash
pnpm install
pnpm test          # юнит-тесты
pnpm test:int      # интеграционные (PostgreSQL в testcontainers)
pnpm typecheck && pnpm lint
```

Локальный запуск API:

```bash
docker run -d --name cr-pg -e POSTGRES_USER=app -e POSTGRES_PASSWORD=app -e POSTGRES_DB=app -p 5432:5432 postgres:17-alpine
cp .env.example .env   # заполнить секреты
cd apps/api && node --env-file=../../.env --import tsx src/server.ts
```

## Запуск в Docker

Нужен Docker с Compose v2.24+. Первый запуск скачивает образы OnlyOffice и Carbone (несколько ГБ).

```bash
cp .env.example .env      # заполнить обязательные переменные
```

**Разработка** (API с hot reload, интерфейс на http://localhost:8080, API напрямую на :3000, PostgreSQL на :55433; порты 8080, 3000 и 55433 слушают только 127.0.0.1):

```bash
pnpm stack:dev
```

**Прод** (HTTPS в nginx; положите сертификат и ключ в `certs/fullchain.pem` и `certs/privkey.pem`;
для локальной проверки — `./scripts/dev-cert.sh`):

```bash
pnpm stack:prod
```

Редирект с HTTP на HTTPS ведёт на стандартный порт 443; если `WEB_HTTPS_PORT` другой, открывайте `https://host:<порт>` напрямую.

**Проверка работающего стека** (сначала `pnpm install` на хосте):

```bash
pnpm stack:smoke                                        # разработка, http://localhost:8080
BASE_URL=https://localhost pnpm stack:smoke --insecure  # прод с самоподписанным сертификатом
```

Если `WEB_HTTPS_PORT` не 443, укажите порт в `BASE_URL`, например `BASE_URL=https://localhost:8443`.

Остановить: `pnpm stack:down` (данные сохраняются в томах; `docker compose down -v` удалит их).

Наружу в проде открыт только nginx. Маршруты `/internal/*` закрыты: их вызывает только OnlyOffice внутри сети.
Режимы разработки и прода на одном хосте используют один проект compose, а значит общие тома `pgdata` и `storage`. Образ разработки называется `carbone-reports-api:dev` и не затирает прод-образ.

### Данные

Состояние хранится в томах `pgdata` (PostgreSQL) и `storage` (файлы шаблонов и отчётов). Тома `carbone_templates` и `oo_*` восстанавливаются сами. Резервные копии — в разделе [«Резервное копирование»](#резервное-копирование).

`POSTGRES_PASSWORD` применяется только при первом создании тома `pgdata`; позже пароль меняется внутри PostgreSQL (`ALTER USER`), а не в `.env`.

### Запуск из готовых образов

CI публикует образы после зелёных проверок:

- `ghcr.io/samrozhkov/carbone-report-api`, `ghcr.io/samrozhkov/carbone-report-web`;
- теги: `latest` и `main` — последняя сборка `main`, `sha-<коммит>`, `X.Y.Z` и `X.Y` — релизы по тегам `vX.Y.Z`.

```bash
# в .env
API_IMAGE=ghcr.io/samrozhkov/carbone-report-api:1.0.0
WEB_IMAGE=ghcr.io/samrozhkov/carbone-report-web:1.0.0

docker compose pull api web
docker compose up -d --no-build
```

С заданными `API_IMAGE`/`WEB_IMAGE` не используйте `pnpm stack:*`: они пересобирают локальные исходники и тегируют их под имя релиза. Применяйте `docker compose pull` и `up -d --no-build`.

Новые пакеты GHCR приватные: сделайте их публичными (Package settings → Change visibility) или войдите на сервере: `echo <token> | docker login ghcr.io -u <user> --password-stdin` (токен с правом `read:packages`).

### Обновление / выкат

Перед обновлением сделайте [ручной бэкап](#резервное-копирование) (`docker compose --profile backup run --rm backup now`): миграции выполняются при старте API, а миграция 0002 удаляет колонку `ssl`, поэтому откат возможен только восстановлением из копии. После этого обновления каждому пользователю один раз нужно войти заново.
`stack:smoke --carbone-restart` разрушителен (пересоздаёт carbone и удаляет том с кэшем шаблонов) и предназначен только для стендов разработки; даже на проде через localhost это даёт около 40 с простоя Carbone.

Сессионная cookie в проде помечена `Secure`, поэтому интерфейс работает только по HTTPS.

### Резервное копирование

**Что входит в бэкап:** база `app` (`pg_dump -Fc`) и файлы шаблонов и отчётов (том `storage`). Дамп и архив снимаются под одной блокировкой, поэтому они согласованы: пока идёт бэкап, API откладывает удаление файлов.

**Что не входит:**

- `.env` с `ENCRYPTION_KEY`: без него пароли источников данных из бэкапа не расшифровать;
- `certs/`;
- кэши OnlyOffice и Carbone (тома `oo_*` и `carbone_templates` восстанавливаются сами).

Храните `.env` и `certs/` отдельно и надёжно.

Каждый бэкап — каталог `backups/<ГГГГ-ММ-ДДTЧЧ-ММ-ССZ>/` (или в вашем `BACKUP_DIR`; время UTC) с файлами `db.dump`, `storage.tar.gz` и `manifest.txt` (размеры и sha256). Незавершённый бэкап остаётся с суффиксом `.partial` и не участвует в ротации.

**По расписанию:**

```bash
docker compose --profile backup up -d
```

Переменные в `.env`:

- `BACKUP_CRON` — расписание в формате cron, по умолчанию `0 3 * * *`. Время берётся в часовом поясе `TZ` (по умолчанию `Europe/Moscow`), а не в UTC;
- `BACKUP_KEEP` — сколько последних копий хранить, по умолчанию 14;
- `BACKUP_DIR` — каталог на хосте, по умолчанию `./backups`.

Журнал: `docker compose --profile backup logs backup`.

**Вручную**, например перед выкатом:

```bash
docker compose --profile backup run --rm backup now
```

**Восстановление:**

```bash
scripts/restore.sh backups/<каталог>
```

Скрипт:

1. сверяет sha256 файлов с `manifest.txt`;
2. просит ввести `restore` для подтверждения;
3. приостанавливает бэкап по расписанию (сервис `backup`), если он запущен;
4. останавливает `api` и `web` (интерфейс недоступен до конца восстановления);
5. заменяет базу `app` дампом (`pg_restore --clean --single-transaction`);
6. заменяет содержимое тома `storage` архивом (архив проверяется до удаления старых файлов);
7. запускает `api` и `web`, затем снова `backup`.

Если шаг после остановки `api` и `web` завершился ошибкой, скрипт сообщает, успела ли замениться база, снова запускает `backup` и оставляет `api` и `web` остановленными: устраните причину и запустите скрипт снова или верните стек командой `docker compose up -d --wait api web`.

Восстанавливать можно и в чистый стек: сначала поднимите его с тем же `.env`, затем запустите скрипт. После восстановления в более новую версию приложения API при старте применит недостающие миграции.

**Копия на другой сервер** остаётся за администратором, например по cron на хосте:

```bash
rsync -a --exclude '*.partial' backups/ backup-host:/srv/carbone-reports-backups/
```

Здесь `backups/` — каталог по умолчанию (или ваш `BACKUP_DIR`). Ротацию копий на удалённой стороне настраивает администратор.

## Разработка интерфейса

Интерфейс — `apps/web` (React 19, Gravity UI, Vite). Бэкенд, OnlyOffice и Carbone берутся из dev-стека:

```bash
pnpm stack:dev                               # API, OnlyOffice, Carbone, PostgreSQL (nginx на :8080)
pnpm --filter @carbone-reports/web dev       # интерфейс с hot reload на http://localhost:5173
```

Vite проксирует `/api` и `/onlyoffice` (включая WebSocket) на `http://localhost:8080`; другой адрес стека — переменная `STACK_URL`.
Тесты интерфейса: `pnpm --filter @carbone-reports/web test`. В прод-образе (`pnpm stack:prod`) интерфейс собирается в `docker/web.Dockerfile`.

## Демо и E2E

```bash
pnpm stack:demo     # прод-стек + демо-БД + шаблон «Счёт (демо)» (нужен DEMO_DB_PASSWORD в .env)
pnpm e2e            # E2E на Playwright (Chromium на хосте) против поднятого стека
pnpm stack:down     # остановить
```

Первый запуск E2E: `pnpm --filter @carbone-reports/e2e exec playwright install chromium`.
Отчёт — `e2e/report/index.html`; при падении trace сохраняется в `e2e/test-results/`.
E2E меняет демо-шаблон. Перед каждым прогоном он сам восстанавливает исходный файл, запросы и параметры (`e2e/global-setup.ts`); после прогона шаблон остаётся изменённым. Вручную: `pnpm demo:seed -- --reset-template`.
Пароль `DEMO_DB_PASSWORD` задаётся ролям демо-БД только при первом создании тома. Если вы поменяли его позже, пересоздайте том демо-БД (другие тома не трогаются):

```bash
docker compose --profile demo rm -sf demo-db && docker volume rm carbone-reports_demo_pgdata && pnpm stack:demo
```

## Безопасность источников данных

Подключайте источники под отдельным пользователем PostgreSQL с правами только на чтение
(`GRANT SELECT`). Приложение дополнительно выполняет запросы в `READ ONLY`-транзакции с
`statement_timeout`, но права на уровне БД — основная защита.

SSL источника задаётся одним из трёх режимов:

- «Без SSL» (`disable`);
- «SSL без проверки сертификата» (`require`): трафик шифруется, но защиты от подмены сервера нет,
  поэтому используйте этот режим только во внутренней сети;
- «SSL с проверкой сертификата» (`verify`): сертификат сервера проверяется. Для самоподписанного
  или внутреннего сертификата укажите свой CA в формате PEM.

В API поле `sslMode` обязательно.

## Конфигурация

`MIGRATIONS_DIR` — необязательная папка с миграциями БД, по умолчанию `./drizzle` относительно
текущей директории процесса.

## Формат ошибок

Ошибки возвращаются как `{ error: { code, message, details? } }`. У ошибок с `code: "VALIDATION"`
`details` бывает двух видов: `[{ path, message }]` при проверке схемы запроса и `{ fields }`
(поле → сообщение) при проверке параметров отчёта.
