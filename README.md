# Carbone Reports

Генерация отчётов на базе Carbone с редактированием шаблонов в браузере (OnlyOffice) и интерфейсом на GravityUI.

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

**Разработка** (API с hot reload, интерфейс на http://localhost:8080, API напрямую на :3000, PostgreSQL на :55433):

```bash
pnpm stack:dev
```

**Прод** (HTTPS в nginx; положите сертификат и ключ в `certs/fullchain.pem` и `certs/privkey.pem`;
для локальной проверки — `./scripts/dev-cert.sh`):

```bash
pnpm stack:prod
```

Редирект с HTTP на HTTPS ведёт на стандартный порт 443; если `WEB_HTTPS_PORT` другой, открывайте `https://host:<порт>` напрямую.

**Проверка работающего стека:**

```bash
pnpm stack:smoke                                        # разработка, http://localhost:8080
BASE_URL=https://localhost pnpm stack:smoke --insecure  # прод с самоподписанным сертификатом
```

Остановить: `pnpm stack:down` (данные сохраняются в томах; `docker compose down -v` удалит их).

Наружу в проде открыт только nginx. Маршруты `/internal/*` закрыты: их вызывает только OnlyOffice внутри сети.
Сессионная cookie в проде помечена `Secure`, поэтому интерфейс работает только по HTTPS.

## Безопасность источников данных

Подключайте источники под отдельным пользователем PostgreSQL с правами только на чтение
(`GRANT SELECT`). Приложение дополнительно выполняет запросы в `READ ONLY`-транзакции с
`statement_timeout`, но права на уровне БД — основная защита.

SSL-подключения к источникам шифруют трафик, но не проверяют сертификат сервера
(защиты от подмены сервера нет), поэтому используйте их только во внутренней сети.

## Конфигурация

`MIGRATIONS_DIR` — необязательная папка с миграциями БД, по умолчанию `./drizzle` относительно
текущей директории процесса.

## Формат ошибок

Ошибки возвращаются как `{ error: { code, message, details? } }`. У ошибок с `code: "VALIDATION"`
`details` бывает двух видов: `[{ path, message }]` при проверке схемы запроса и `{ fields }`
(поле → сообщение) при проверке параметров отчёта.
