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
