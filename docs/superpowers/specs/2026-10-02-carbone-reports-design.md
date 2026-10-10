# Carbone Reports — дизайн-спецификация

Дата: 2026-10-02
Статус: утверждена

## 1. Цель

Веб-приложение для генерации отчётов на базе [Carbone](https://carbone.io) с интерфейсом на GravityUI.

- Администратор создаёт и редактирует шаблоны (DOCX/XLSX/ODT/PPTX) прямо в браузере через встроенный OnlyOffice, описывает SQL-запросы к PostgreSQL и параметры отчёта.
- Пользователь выбирает отчёт, заполняет параметры и получает готовый файл (PDF, DOCX, XLSX…).

**Критерий успеха:** админ создаёт шаблон в браузере, вставляет теги, пишет SQL. Пользователь без админских прав получает готовый PDF за пару кликов. Всё разворачивается одним `docker compose up`.

### Не входит в MVP

SSO/LDAP, СУБД-источники кроме PostgreSQL, история версий шаблонов с откатом, очередь фоновых генераций, рассылки по расписанию, права на отдельные шаблоны.

## 2. Архитектура

### 2.1 Сервисы (`docker-compose.yml`)

| Сервис                     | Роль                                                                                                        |
| -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `web`                      | nginx: раздаёт SPA (React + GravityUI), проксирует `/api/*` → `api:3000`, `/onlyoffice/*` → `onlyoffice:80` |
| `api`                      | Node.js 22 + Fastify + TypeScript. Бизнес-логика, авторизация, выполнение SQL, интеграции                   |
| `carbone`                  | Официальный Docker-образ Carbone (HTTP API), рендер шаблонов                                                |
| `onlyoffice`               | OnlyOffice Document Server, редактирование шаблонов                                                         |
| `postgres`                 | Метаданные приложения                                                                                       |
| `demo-db` (profile `demo`) | Демо-БД с данными для отчётов                                                                               |
| volume `storage`           | `/data/templates`, `/data/reports` (смонтирован в `api`)                                                    |

Браузер обращается только к `web`. Document Server обращается к `api` по внутренней сети через `API_INTERNAL_URL` (`http://api:3000`). Все запросы между `api` и Document Server подписаны `ONLYOFFICE_JWT_SECRET`.

### 2.2 Модули `api`

| Модуль        | Ответственность                                                                                                         |
| ------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `auth`        | Вход по логину и паролю (argon2), сессия — JWT в httpOnly cookie, guard'ы `requireUser` / `requireAdmin`                |
| `users`       | CRUD пользователей (admin), блокировка                                                                                  |
| `datasources` | CRUD подключений к PostgreSQL, пул `pg.Pool` на каждый источник (lazy, сбрасывается при изменении), проверка соединения |
| `queries`     | Разбор `:param` → `$n`, выполнение запросов в read-only транзакции, сборка JSON                                         |
| `templates`   | Метаданные и файлы шаблонов, запросы и параметры шаблона                                                                |
| `onlyoffice`  | Конфиг редактора, подпись JWT, callback сохранения, forcesave через Command Service                                     |
| `carbone`     | Адаптер `CarboneClient.render(file, data, opts): Promise<Buffer>`. Единственное место, которое знает про API Carbone    |
| `reports`     | Запуск генерации, история, выдача файлов, очистка старых файлов                                                         |

Общие библиотеки: `lib/crypto` (AES-256-GCM), `lib/storage` (атомарная запись: tmp → rename), `lib/config` (env через zod).

## 3. Модель данных (БД приложения)

ORM — Drizzle, миграции применяются при старте `api`.

```
users             id uuid pk, login text unique, password_hash text,
                  role text check (admin|user), blocked bool default false,
                  created_at timestamptz

datasources       id uuid pk, name text, host text, port int, database text,
                  username text, password_enc text, ssl bool, created_at

templates         id uuid pk, name text, description text,
                  datasource_id uuid fk → datasources,
                  file_ext text check (docx|xlsx|odt|ods|pptx),
                  file_path text, version int default 1,
                  doc_key text,                -- ключ документа OnlyOffice
                  default_output text,         -- pdf|docx|xlsx|odt|ods
                  updated_at timestamptz, updated_by uuid fk → users

template_queries  id uuid pk, template_id uuid fk (cascade), key text,
                  sql text, mode text check (list|single), sort_order int,
                  unique (template_id, key)

template_params   id uuid pk, template_id uuid fk (cascade), name text,
                  label text, type text check (string|number|date|boolean|select),
                  required bool, default_value jsonb, options jsonb,
                  sort_order int, unique (template_id, name)

report_runs       id uuid pk, template_id uuid fk (set null), template_version int,
                  user_id uuid fk, params jsonb, output_format text,
                  status text check (ok|error), error text, file_path text null,
                  file_deleted bool default false, duration_ms int,
                  created_at timestamptz
```

Ключ запроса (`key`) и имя параметра (`name`) должны соответствовать `^[a-zA-Z_][a-zA-Z0-9_]*$`. Ключ `params` зарезервирован.

## 4. Данные для Carbone

Результаты запросов шаблона собираются в один объект:

- `mode=list` → `{ [key]: Row[] }`
- `mode=single` → `{ [key]: Row | null }` (первая строка)
- всегда добавляется `{ params: { ...значения параметров } }`

В шаблоне: `{d.orders[i].total}`, `{d.company.name}`, `{d.params.dateFrom}`.

Преобразование типов: `numeric`/`bigint` → number (через type parser `pg`), `date`/`timestamp` → ISO-строка, `json`/`jsonb` → объект как есть.

### 4.1 Разбор параметров SQL

`:name` заменяется на `$n` (одинаковые имена получают один номер). Не трогаются:

- приведения типов `::type`;
- содержимое строковых литералов `'...'` (включая `''`), `E'...'` и dollar-quoted строк `$tag$...$tag$`;
- идентификаторы в кавычках `"..."`;
- комментарии `-- ...` и `/* ... */`.

Если в SQL встречается параметр, которого нет в `template_params`, это ошибка конфигурации: `400` при сохранении запроса или при запуске.

### 4.2 Безопасность выполнения

- Значения передаются только через bind-параметры. Подстановки строк в SQL нет.
- Все запросы одного запуска выполняются на одном соединении в транзакции `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY` с `SET LOCAL statement_timeout = QUERY_TIMEOUT_MS`. После выполнения всегда `ROLLBACK`.
- Лимит строк `QUERY_MAX_ROWS` на запрос. Строки читаются курсором (`pg-cursor`) порциями. При превышении — ошибка «запрос `X` вернул больше N строк».
- Писать SQL могут только админы. Пользователь передаёт только значения параметров, которые проверяются по типам.
- Пароли источников хранятся зашифрованными AES-256-GCM (`ENCRYPTION_KEY`) и никогда не отдаются в API.
- В README будет рекомендация подключать источники под read-only пользователем БД.

### 4.3 Валидация параметров

На основе `template_params` строится zod-схема:

| type    | Принимается               | Значение в SQL и данных |
| ------- | ------------------------- | ----------------------- |
| string  | строка                    | string                  |
| number  | число                     | number                  |
| date    | `YYYY-MM-DD`              | string `YYYY-MM-DD`     |
| boolean | boolean                   | boolean                 |
| select  | одно из `options[].value` | value                   |

Если параметр отсутствует, подставляется `default_value`. Если его нет и параметр `required`, возвращается ошибка поля. Отсутствующий необязательный параметр передаётся как `null`.

## 5. Интеграция с OnlyOffice

### 5.1 Открытие

`GET /api/templates/:id/editor-config` (admin) возвращает конфиг, подписанный `ONLYOFFICE_JWT_SECRET` (поле `token`):

```jsonc
{
  "document": {
    "fileType": "docx",
    "key": "<templates.doc_key>",
    "title": "<name>.docx",
    "url": "<API_INTERNAL_URL>/internal/templates/:id/file?t=<JWT 10 мин>",
  },
  "documentType": "word", // word | cell | slide по расширению
  "editorConfig": {
    "callbackUrl": "<API_INTERNAL_URL>/internal/onlyoffice/callback/:id",
    "user": { "id": "<userId>", "name": "<login>" },
    "lang": "ru",
    "customization": { "forcesave": true },
  },
}
```

На фронте используется `<DocumentEditor>` из `@onlyoffice/document-editor-react`, `documentServerUrl = /onlyoffice/`.

### 5.2 Сохранение

- Кнопка «Сохранить» в UI вызывает `POST /api/templates/:id/save`. `api` отправляет `{"c":"forcesave","key":doc_key}` (с JWT) в Command Service Document Server.
- `POST /internal/onlyoffice/callback/:id`:
  - JWT проверяется из `Authorization` или поля `token` тела. Если подпись неверна — `403`;
  - `status 2` (документ закрыт всеми) и `status 6` (forcesave): файл скачивается по `url`, записывается атомарно, `version++`, обновляются `updated_at` и `updated_by` (по `users[0]`);
  - только при `status 2` дополнительно генерируется новый `doc_key`. Во время активной сессии ключ не меняется;
  - `status 3`/`7` (ошибка сохранения): запись в лог, событие доступно фронту через `GET /api/templates/:id` (`lastSaveError`);
  - остальные статусы: только подтверждение;
  - ответ всегда `{"error":0}`, кроме ошибки подписи.
- `GET /internal/templates/:id/file?t=` отдаёт файл после проверки токена.
- Маршруты `/internal/*` не проксируются через nginx `web`: они доступны только во внутренней сети.

### 5.3 Создание шаблона

При создании «пустого» шаблона копируется встроенная пустая заготовка (`assets/blank.docx|xlsx|pptx`). При загрузке файла проверяются расширение и размер (≤ 20 МБ). `doc_key` — случайный uuid.

## 6. Генерация отчёта

`POST /api/reports/:templateId/render` `{ params, format }` (user/admin):

1. Валидация параметров и формата. При ошибке — `400 { fields: {...} }`.
2. Выполнение запросов (§4.2) и сборка данных (§4).
3. `CarboneClient.render(file, data, { convertTo: format, lang: "ru", timezone: TZ })`:
   - `POST /template` загружает файл. Полученный `templateId` кэшируется в памяти по ключу `(template.id, version)`;
   - `POST /render/:templateId` с `{ data, convertTo, lang, timezone }` → `renderId`;
   - `GET /render/:renderId` → Buffer.
4. Файл записывается в `/data/reports/{runId}.{format}`, в `report_runs` добавляется запись. Ответ — `{ runId }`.
5. Фронт скачивает файл через `GET /api/runs/:id/file`. Доступ есть у владельца запуска и у админа.

Общий таймаут — `RENDER_TIMEOUT_MS`. Неудачные запуски записываются со `status=error`.

Очистка: раз в час удаляются файлы запусков старше `REPORT_RETENTION_DAYS`, у записей выставляется `file_deleted=true`.

### 6.1 Предпросмотр для админа (без записи в историю)

- `POST /api/templates/:id/queries/run` `{ sql, params }` → `{ columns, rows (≤50), rowCount }`
- `POST /api/templates/:id/preview` `{ params, mode: "data" | "pdf" }` → JSON данных или PDF

### 6.2 Ошибки

| Ситуация                | HTTP | Сообщение                                      |
| ----------------------- | ---- | ---------------------------------------------- |
| Неверные параметры      | 400  | ошибки по полям                                |
| Ошибка SQL              | 400  | `запрос "<key>": <сообщение PostgreSQL>`       |
| Источник недоступен     | 502  | `не удалось подключиться к источнику "<name>"` |
| Ошибка Carbone          | 502  | текст ошибки Carbone                           |
| Таймаут SQL или рендера | 504  | `превышено время ожидания`                     |

Формат ответа об ошибке: `{ error: { code, message, details? } }`.

## 7. API (сводка)

```
POST   /api/auth/login | /api/auth/logout      GET /api/auth/me
GET/POST/PATCH/DELETE /api/users[/:id]                         admin
GET/POST/PATCH/DELETE /api/datasources[/:id]                   admin
POST   /api/datasources/:id/test                               admin
GET    /api/templates                                          user (краткий список)
GET    /api/templates/:id                                      user: name, description, params, formats
                                                               admin: + queries, datasource, lastSaveError
POST   /api/templates            (multipart или {blank: ext})  admin
PATCH/DELETE /api/templates/:id                                admin
POST   /api/templates/:id/duplicate                            admin
PUT    /api/templates/:id/queries      (весь список)           admin
PUT    /api/templates/:id/params       (весь список)           admin
POST   /api/templates/:id/queries/run                          admin
POST   /api/templates/:id/preview                              admin
GET    /api/templates/:id/editor-config                        admin
POST   /api/templates/:id/save                                 admin
GET    /api/templates/:id/download                             admin
POST   /api/reports/:templateId/render                         user
GET    /api/runs?templateId&userId&status&page                 user (свои) / admin (все)
GET    /api/runs/:id/file                                      владелец / admin
GET    /internal/templates/:id/file                            OnlyOffice
POST   /internal/onlyoffice/callback/:id                       OnlyOffice
```

## 8. Интерфейс (GravityUI)

Пакеты: `@gravity-ui/uikit`, `@gravity-ui/navigation`, `@gravity-ui/date-components`, `@gravity-ui/icons`, `@monaco-editor/react`, `@onlyoffice/document-editor-react`, `react-router`, `@tanstack/react-query`.

Основа: `ThemeProvider` (светлая и тёмная тема с переключателем в футере `AsideHeader`), `AsideHeader` с навигацией по роли, `Toaster`. Интерфейс на русском.

| Экран            | Маршрут                | Роль  | Содержимое                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------- | ---------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Вход             | `/login`               | все   | `Card`, `TextInput` ×2, `Button`                                                                                                                                                                                                                                                                                                                                                                                                 |
| Отчёты           | `/reports`             | user  | Сетка `Card` (название, описание, `Label` формата), поиск                                                                                                                                                                                                                                                                                                                                                                        |
| Генерация        | `/reports/:id`         | user  | Форма параметров (string → `TextInput`, number → `NumberInput`, date → `DatePicker`, boolean → `Checkbox`, select → `Select`), `SegmentedRadioGroup` формата, `Button loading`. Ошибки в `Alert`. Справа предпросмотр PDF (`<iframe>`) и кнопка скачивания                                                                                                                                                                       |
| История          | `/history`             | user  | `Table` + `withTableSorting`: шаблон, параметры, формат, статус (`Label`), время, длительность, «Скачать». Админ видит всех и может фильтровать по пользователю                                                                                                                                                                                                                                                                  |
| Шаблоны          | `/admin/templates`     | admin | `Table` + `withTableActions` (открыть / дублировать / скачать / удалить), `Dialog` создания (имя, источник, пустой docx/xlsx/pptx или загрузка файла)                                                                                                                                                                                                                                                                            |
| Редактор шаблона | `/admin/templates/:id` | admin | `Tabs`: **Документ** (OnlyOffice + сворачиваемая панель «Теги»: дерево из последнего preview-JSON, клик копирует тег, для массивов предлагается `[i]` и строка `[i+1]`), **Данные** (список запросов, Monaco SQL, режим list/single, «Выполнить», `Table` с результатом), **Параметры** (редактируемая `Table`), **Предпросмотр** (форма тестовых параметров, Monaco JSON только для чтения, «Сгенерировать PDF»), **Настройки** |
| Источники        | `/admin/datasources`   | admin | `Table`, `Dialog` с полями подключения, «Проверить соединение» → `Alert`                                                                                                                                                                                                                                                                                                                                                         |
| Пользователи     | `/admin/users`         | admin | `Table`, `Dialog` (логин, пароль, роль), блокировка                                                                                                                                                                                                                                                                                                                                                                              |

Тестовые параметры редактора и последний preview-JSON хранятся в `localStorage` отдельно для каждого шаблона.

## 9. Репозиторий

```
carbone-reports/
├── apps/
│   ├── web/src/{app,pages,features,api}
│   └── api/src/{modules,db,lib}, api/assets/blank.*
├── packages/shared/          zod-схемы и DTO
├── docker/                   nginx.conf, Dockerfile.web, Dockerfile.api
├── demo/                     invoice.docx, seed.sql
├── e2e/                      Playwright
├── docker-compose.yml
├── .env.example
└── README.md
```

Монорепо на pnpm workspaces, TypeScript strict, ESLint + Prettier.

## 10. Конфигурация (env `api`)

| Переменная                       | По умолчанию          | Назначение                                     |
| -------------------------------- | --------------------- | ---------------------------------------------- |
| `DATABASE_URL`                   | —                     | БД приложения                                  |
| `APP_SECRET`                     | —                     | подпись сессий                                 |
| `ENCRYPTION_KEY`                 | —                     | 32 байта base64, шифрование паролей источников |
| `ONLYOFFICE_JWT_SECRET`          | —                     | общий секрет с Document Server                 |
| `ONLYOFFICE_INTERNAL_URL`        | `http://onlyoffice`   | Command Service                                |
| `API_INTERNAL_URL`               | `http://api:3000`     | адрес `api` для Document Server                |
| `CARBONE_URL`                    | `http://carbone:4000` | Carbone                                        |
| `ADMIN_LOGIN` / `ADMIN_PASSWORD` | —                     | первый админ, если пользователей нет           |
| `STORAGE_DIR`                    | `/data`               | хранилище файлов                               |
| `QUERY_TIMEOUT_MS`               | `30000`               |                                                |
| `QUERY_MAX_ROWS`                 | `100000`              |                                                |
| `RENDER_TIMEOUT_MS`              | `120000`              |                                                |
| `REPORT_RETENTION_DAYS`          | `30`                  |                                                |
| `TZ`                             | `Europe/Moscow`       | таймзона рендера                               |

`docker compose --profile demo up` дополнительно поднимает `demo-db` и при пустой БД приложения создаёт демо-источник и шаблон «Счёт» с запросами `company` (single) и `items` (list) и параметром `invoiceId`.

## 11. Тестирование

Инструменты: Vitest, Testing Library, testcontainers, Playwright.

**api, юнит-тесты:**

- парсер параметров SQL: `::cast`, строки, `E''`, dollar-quoting, `"идентификаторы"`, оба вида комментариев, повторяющиеся параметры, неизвестный параметр;
- сборка данных (`list`/`single`/`params`, пустой результат для `single` → `null`);
- построение zod-схемы параметров и значения по умолчанию;
- callback OnlyOffice: неверный JWT → 403; статусы 2/6 → сохранение и `version++`; новый `doc_key` только при статусе 2; статусы 3/7 → `lastSaveError`;
- crypto: шифрование, расшифровка, подмена шифротекста → ошибка;
- `CarboneClient` на `undici MockAgent`: успешный процесс, кэш `templateId`, ошибки и таймаут.

**api, интеграционные тесты** (testcontainers PostgreSQL):

- read-only: `INSERT` в запросе падает;
- `statement_timeout` срабатывает (`pg_sleep`);
- `QUERY_MAX_ROWS` работает;
- права: user получает 403 на `/api/users`, `/api/datasources`, `/queries/run`; user не может скачать чужой запуск.

**web:** форма параметров по описанию (типы, required, default), дерево тегов из JSON (вложенные объекты, массивы → `[i]`).

**E2E smoke** (Playwright, `docker compose --profile demo`): вход админом → открытие редактора демо-шаблона, iframe OnlyOffice загрузился → вход пользователем → генерация «Счёта» в PDF → PDF скачивается и содержит название компании из демо-данных.

## 12. Уточнения после планирования

Детали зафиксированы в `docs/superpowers/plans/2026-10-02-carbone-reports-backend.md`, раздел «Уточнения спецификации». Кратко:

- Пустой шаблон создаётся только как docx или xlsx. Остальные форматы добавляются загрузкой файла.
- Новые маршруты: `POST /api/templates/upload`, `PUT /api/templates/:id/file`, `POST /api/datasources/test`.
- `report_runs.template_name`, `templates.last_save_error`.
- `queries/run` возвращает `truncated` вместо `rowCount`.
- Неизвестные `:param` проверяются при выполнении запроса.
- Ошибки валидации параметров не пишутся в историю.
- Carbone вызывается через `POST /render/:id?download=true` (Carbone 5, заголовок `carbone-version: 5`).
- OnlyOffice Command Service доступен по пути `/command`. В Document Server нужно задать `ALLOW_PRIVATE_IP_ADDRESS=true`, чтобы он мог обращаться к `api` во внутренней сети.
- `bigint`/`numeric` больше 2^53−1 по модулю передаются строкой.

## 13. Развёртывание: Docker Compose для разработки и прода

Утверждено 2026-10-02. Заменяет часть «docker-compose» Плана 3. Демо-профиль и E2E на Playwright остаются за Планом 3 и делаются после фронтенда.

### 13.1 Файлы и запуск

```
docker-compose.yml          базовый файл = прод
docker-compose.dev.yml      override для разработки
docker/api.Dockerfile       multi-stage: target dev / target prod
docker/web.Dockerfile       nginx + конфиг + статика (сейчас заглушка; в Плане 2 — сборка React)
docker/nginx/common.conf    общие location
docker/nginx/prod.conf      80 → 301 на 443, TLS, HSTS, include common.conf
docker/nginx/dev.conf       HTTP, include common.conf
docker/web/placeholder/index.html
scripts/dev-cert.sh         самоподписанный сертификат в ./certs для локальной проверки прода
scripts/smoke.ts            сквозная проверка работающего стека
```

- Прод: `docker compose up -d --build`, короткая команда `pnpm stack:prod`.
- Разработка: `docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build`, короткая команда `pnpm stack:dev`.
- Проверка: `pnpm stack:smoke` (переменная `BASE_URL`).

### 13.2 Сервисы

| Сервис | Прод | Разработка (override) |
|---|---|---|
| `web` (nginx) | Порты `${WEB_HTTP_PORT:-80}` и `${WEB_HTTPS_PORT:-443}`, сертификаты `./certs/fullchain.pem` и `./certs/privkey.pem` (read-only) | Только HTTP, `${WEB_DEV_PORT:-8080}`, `dev.conf` |
| `api` | Target `prod`: собранный `dist/server.js`, prod-зависимости, `drizzle/`, пользователь `node`, `WORKDIR` с `drizzle/`, healthcheck `GET /api/health`, `COOKIE_SECURE=true` | Target `dev`: исходники смонтированы, `tsx watch`, `node_modules` в именованных томах (нативный argon2 собирается под Linux), порт 3000 открыт, `COOKIE_SECURE=false` |
| `postgres` | `postgres:17-alpine`, том `pgdata`, healthcheck `pg_isready` | Порт `${POSTGRES_DEV_PORT:-55433}` открыт |
| `carbone` | `carbone/carbone-ee` с закреплённым тегом, без healthcheck (в образе нет curl, wget и node; осознанное отступление), том для шаблонов | Без изменений |
| `onlyoffice` | `onlyoffice/documentserver` с закреплённым тегом. `JWT_ENABLED=true`, `JWT_SECRET=${ONLYOFFICE_JWT_SECRET}`, `ALLOW_PRIVATE_IP_ADDRESS=true`. Тома для данных и логов | Без изменений |

- В проде наружу открыт только `web`.
- `api` ждёт, пока `postgres` станет healthy.
- Том `storage` монтируется в `/data` сервиса `api`.
- Все сервисы перезапускаются с политикой `unless-stopped`.

### 13.3 nginx (common.conf)

- `/api/` → `http://api:3000`:
  - `client_max_body_size 25m`;
  - `proxy_read_timeout 180s`;
  - заголовки `X-Forwarded-For` и `X-Forwarded-Proto`.
- `/onlyoffice/` → `http://onlyoffice/` (префикс срезается):
  - поддержка WebSocket (`Upgrade`/`Connection`);
  - `X-Forwarded-Host $http_host/onlyoffice`, `X-Forwarded-Proto`;
  - `proxy_set_header Cookie ""`;
  - `client_max_body_size 100m`.
- `/internal/` → `return 404`.
- Остальные пути отдаются как статика из `/usr/share/nginx/html` с `try_files $uri /index.html`.

### 13.4 Конфигурация

`.env` в корне. `.env.example` описывает все переменные.

- **Обязательные:** `APP_SECRET`, `ENCRYPTION_KEY`, `ONLYOFFICE_JWT_SECRET`, `POSTGRES_PASSWORD`, `ADMIN_LOGIN`, `ADMIN_PASSWORD`. В compose они задаются через `${VAR:?сообщение}`.
- **Собираются в compose:**
  - `DATABASE_URL=postgres://app:${POSTGRES_PASSWORD}@postgres:5432/app`
  - `CARBONE_URL=http://carbone:4000`
  - `ONLYOFFICE_INTERNAL_URL=http://onlyoffice`
  - `API_INTERNAL_URL=http://api:3000`
  - `STORAGE_DIR=/data`
- **Необязательные:** порты, `TZ` и лимиты из §10, значения по умолчанию оттуда же.

### 13.5 Smoke-проверка (`scripts/smoke.ts`)

Скрипт запускается против поднятого стека. Для самоподписанного сертификата есть флаг `--insecure`.

1. `GET /api/health` через `web` → `{"status":"ok"}`. `GET /internal/templates/x/file` через `web` → 404.
2. Вход админа (`ADMIN_LOGIN`/`ADMIN_PASSWORD`).
3. Генерация отчёта на реальном Carbone:
   - создаётся источник данных на сервис `postgres` (база `app`);
   - загружается DOCX с текстом `{d.company.name}`, который скрипт собирает через jszip;
   - сохраняется запрос `company` (single) `select 'ООО Ромашка' as name`;
   - `POST /api/reports/:id/render` в формате `pdf` → скачанный файл начинается с `%PDF`.
4. `GET /onlyoffice/healthcheck` → `true`. `GET /onlyoffice/web-apps/apps/api/documents/api.js` → 200.
5. Цепочка OnlyOffice → api: из `GET /api/templates/:id/editor-config` берётся `document.url`. Затем `POST /onlyoffice/converter`, подписанный `ONLYOFFICE_JWT_SECRET`, с `url` = `document.url` и `outputtype: pdf`. Ожидается `endConvert: true` и `fileUrl`. Это проверяет сеть между сервисами, разрешение приватных IP и общий JWT.
6. Скрипт удаляет созданные им шаблон и источник данных.

## 14. Демо-данные, E2E и строгая CSP (План 3)

Утверждено 2026-10-05. Уточняет §10 (демо-профиль) и §11 (E2E smoke).

### 14.1 Демо-профиль
- Сервис `demo-db` (`postgres:17-alpine`, `profiles: [demo]`, без опубликованных портов) с данными из `demo/seed.sql`. SQL монтируется в `/docker-entrypoint-initdb.d` и выполняется при первом создании тома `demo_pgdata`. Таблицы:
  - `company`: `id`, `name`, `inn`, `address`;
  - `invoices`: `id`, `company_id`, `number`, `issued_on`;
  - `invoice_items`: `id`, `invoice_id`, `name`, `qty`, `price`.
  
  Счета 1 и 2 содержат по 3 позиции.
- Пользователь `demo_ro` получает только `SELECT`, его пароль задаётся переменной `DEMO_DB_PASSWORD` (обязательна для профиля). Пароль подставляется в SQL через init-скрипт `demo/init.sh`.
- `scripts/demo-seed.ts` наполняет стек только через публичный API, под учётной записью админа из `.env`. Скрипт идемпотентен, поиск ведётся по имени.
  - Создаётся источник «Демо-база» (`demo-db:5432/demo`, пользователь `demo_ro`).
  - Загружается шаблон «Счёт (демо)»: DOCX, который собирает скрипт. В нём:
    - заголовок `Счёт № {d.invoice.number} от {d.invoice.issued_on}`;
    - `{d.company.name}`, `{d.company.address}`;
    - таблица со строкой `{d.items[i].name} | {d.items[i].qty} | {d.items[i].price}` и маркером `{d.items[i+1]}`.
  - Настраиваются запросы:
    - `company` (single): `select c.name, c.inn, c.address from company c join invoices i on i.company_id = c.id where i.id = :invoiceId`;
    - `invoice` (single): `select number, issued_on from invoices where id = :invoiceId`;
    - `items` (list): `select name, qty, price from invoice_items where invoice_id = :invoiceId order by id`.
  - Настраивается параметр `invoiceId`: number, required, по умолчанию 1, подпись «Номер счёта (id)».
- `pnpm stack:demo` = `docker compose --profile demo up -d --build` + ожидание health + `demo-seed`.

### 14.2 E2E (Playwright, хост)
- Пакет `e2e/` (`@carbone-reports/e2e`), браузер Chromium, `BASE_URL` по умолчанию `https://localhost:8443`, `ignoreHTTPSErrors`. Логин и пароль админа берутся из `.env`. Запуск: `pnpm e2e` против поднятого `stack:demo`.
- Общая фикстура:
  - до загрузки страницы скрипт (`addInitScript`) копит события `securitypolicyviolation`, в том числе внутри iframe того же источника;
  - после каждого теста проверяется, что нарушений нет;
  - собираются ошибки консоли.
- Сценарии:
  1. **Пользователь.** Админ создаёт пользователя через интерфейс. Пользователь входит, админского меню нет. Он генерирует «Счёт (демо)» в PDF, и iframe предпросмотра загружается. Затем генерирует DOCX: в скачанном файле есть название компании и позиции счёта 1. Тега ИНН в исходном шаблоне нет, ИНН проверяется в сценарии 3. В «Истории» есть запуск.
  2. **Админ, данные.** «Данные» → выполнить `items` → строки видны. «Предпросмотр» → «Получить данные» → во вкладке «Документ» в дереве тегов есть `{d.company.name}`.
  3. **OnlyOffice, правка.**
     - Вкладка «Документ»: редактор загружается за `/onlyoffice/`, ожидается готовность фрейма.
     - В конец документа вводится `ИНН: {d.company.inn}`.
     - «Сохранить» → «Сохранено, версия N».
     - DOCX отчёта содержит ИНН из `demo-db`.
     - Если ввод в canvas ненадёжен, допускается вставка из буфера обмена.
  4. **Вкладки.** «Документ» → «Данные» → «Документ»: iframe видим и имеет ненулевой размер.
  5. **Наблюдение.** Закрыть редактор (уйти со страницы) и через 20 с запросить `editor-config`: фиксируется, сменился ли `document.key`. Результат пишется в аннотацию теста, тест не падает.
- Тест 3 меняет демо-шаблон, поэтому `demo-seed` умеет заново загружать исходный файл (`--reset-template`, через `PUT /file`). E2E перед прогоном делает то же в `globalSetup` (`e2e/global-setup.ts`): файл, запросы и параметры.

### 14.3 Строгая CSP
- После зелёного прогона E2E с нулём нарушений `Content-Security-Policy-Report-Only` заменяется на `Content-Security-Policy` с той же политикой, и прогон повторяется.
- Если найденное нарушение окажется настоящей потребностью (OnlyOffice, Monaco), директива расширяется точечно и с комментарием.

## 15. План 4: укрепление

Цель — закрыть отложенные пункты безопасности и надёжности из `docs/superpowers/notes/2026-10-02-backend-follow-ups.md` до выхода к реальным пользователям.

### 15.1 Отзыв сессий
- В `users` добавляется `session_version integer not null default 0`. JWT сессии получает claim `sv`. Guard (он и так читает строку пользователя на каждом запросе) возвращает 401, если `sv` отсутствует или не совпадает. Старые cookie без `sv` после выката недействительны: все пользователи один раз входят заново.
- `session_version` увеличивается на 1 при смене пароля, роли или блокировке (`PATCH /api/users/:id`). Если админ меняет собственную запись, в ответе выставляется новая cookie, чтобы текущая сессия не оборвалась.
- `POST /api/users/:id/sessions/revoke` (admin) завершает все сессии пользователя. В таблице пользователей появляется кнопка «Завершить сессии» с подтверждением. Для собственной записи кнопки нет.
- `POST /api/auth/logout-all` завершает все сессии текущего пользователя и очищает cookie. В меню появляется пункт «Выйти везде».

### 15.2 SSL источников данных
- `ssl boolean` заменяется на `ssl_mode text not null` с тремя значениями:
  - `disable` — «Без SSL»;
  - `require` — «SSL без проверки сертификата», настройки `pg`: `{ rejectUnauthorized: false }`;
  - `verify` — «SSL с проверкой сертификата и имени хоста», настройки `pg`: `{ rejectUnauthorized: true, ca? }`.
- Необязательное поле `ssl_ca text`: CA-сертификат в PEM, не секрет. Принимается только при `verify` и должен содержать `-----BEGIN CERTIFICATE-----`. Без него проверка идёт по системным корневым сертификатам.
- Миграция: `ssl=true` → `require`, `ssl=false` → `disable`.
- API: поле `ssl` заменяется на `sslMode` и `sslCa` (`DatasourceBody`, DTO). Фронт меняется одновременно: выбор режима вместо чекбокса, поле PEM видно только при `verify`.
- Ошибка проверки сертификата приходит в «Проверить подключение» понятным текстом: «сертификат не прошёл проверку: <причина>».
- При смене SSL-настроек пул источника пересоздаётся (как при смене пароля).

### 15.3 Срок жизни callback-токена OnlyOffice
- Проверка JWT callback требует `exp` (допуск 60 с) и отклоняет просроченные токены. Если реальный Document Server 9.4 не передаёт `exp`, проверяется `iat` с максимальным возрастом 10 минут. Какой вариант выбрать, фиксируется по снятому с живого стека callback.
- Отклонённый токен получает 403 (стандартная ошибка API). Document Server считает неуспешным любой ответ, кроме `{"error":0}`, и повторит callback со свежим токеном.
- Повтор перехваченного callback после истечения токена больше не срабатывает.

### 15.4 Атомарная запись файла шаблона
- Путь файла зависит от версии: `templates/<id>/v<version>.<ext>`. Новая версия пишется в новый файл. `file_path` и `version + 1` обновляются в одной транзакции. Старый файл удаляется после коммита, ошибка удаления только логируется. Так работают callback OnlyOffice и `PUT /api/templates/:id/file`.
- При сбое коммита база и файл остаются согласованными: прежний путь, прежняя версия. Новый файл остаётся сиротой и ни на что не влияет.
- Callback скачивает файл до блокировки строки. После блокировки он повторно сверяет `doc_key`; если ключ сменился, файл выбрасывается. Строка больше не блокируется на время скачивания.
- Перенос существующих файлов `templates/<id>.<ext>` → `templates/<id>/v<version>.<ext>` выполняется при старте API, идемпотентно.
- Дублирование, удаление и скачивание шаблона работают с новым путём.

### 15.5 Проверки и тесты
- `scripts/smoke.ts --carbone-restart`:
  1. формирует отчёт;
  2. пересоздаёт контейнер `carbone` (`docker compose rm -sf carbone`, затем `up -d --wait carbone`);
  3. формирует отчёт снова.

  Второй отчёт должен пройти за счёт повторной загрузки шаблона. Реальный текст ошибки Carbone и `content-type` записываются в заметку о доработках.
- Интеграционные тесты:
  - пагинация `/api/runs`;
  - 410 при отсутствии файла отчёта;
  - callback с чужим секретом;
  - callback со статусом 7;
  - просроченный callback-токен и токен без `exp`/`iat`;
  - отзыв сессий;
  - режимы SSL, включая Postgres с самоподписанным сертификатом в testcontainers;
  - атомарность записи файла;
  - отсутствие блокировки строки во время скачивания.
- E2E Плана 3 должны оставаться зелёными. Добавляется сценарий «Завершить сессии»: админ завершает сессии пользователя, следующий запрос пользователя уводит его на страницу входа.

## 16. План 5: CI и публикация образов

### 16.1 Проверки
- `.github/workflows/ci.yml` запускается на `push` в любую ветку и на `pull_request` в `main`. Новый запуск на той же ветке отменяет предыдущий (`concurrency` по ref).
- Задание `checks`:
  - Node 22 и pnpm с кэшем;
  - `pnpm install --frozen-lockfile`;
  - `pnpm typecheck`, `pnpm lint`, `pnpm exec prettier --check .`, `pnpm test`.
- Задание `integration`: `pnpm test:int` на testcontainers, с Docker раннера.
- Тесты не должны зависеть от IPv6 на хосте. Интеграционный тест SSL выписывает сертификат только на `DNS:localhost`, а несовпадение имени проверяет подключением к `127.0.0.1`.
- E2E (Playwright с полным стеком) в CI не запускается и остаётся ручным.

### 16.2 Образы
- Задание `images` начинается после зелёных `checks` и `integration`. Оно собирает `docker/api.Dockerfile` и `docker/web.Dockerfile` через buildx с кэшем `type=gha`.
- На PR образы только собираются. На push в `main` и на теги `v*` они публикуются:
  - `ghcr.io/samrozhkov/carbone-report-api`;
  - `ghcr.io/samrozhkov/carbone-report-web`.
- Теги образов:
  - `sha-<7 символов>`;
  - `main` и `latest` для ветки `main`;
  - `X.Y.Z` и `X.Y` для тега `vX.Y.Z`.
- Публикация идёт через `GITHUB_TOKEN`. Права у workflow — `contents: read`; `packages: write` есть только у задания `images`.
- `docker-compose.yml`: у `api` и `web` появляется `image: ${API_IMAGE:-carbone-reports-api}` / `${WEB_IMAGE:-carbone-reports-web}`, сборка (`build`) остаётся. Запуск из готовых образов: указать `API_IMAGE`/`WEB_IMAGE` с тегом, затем `docker compose pull api web && docker compose up -d --no-build`.
- В README появляются значок статуса CI и раздел «Запуск из готовых образов». В разделе сказано, что новые пакеты GHCR приватные: нужна публичная видимость пакета или `docker login ghcr.io`.

### 16.3 Готовность
- Реальный прогон workflow на GitHub для ветки зелёный во всех трёх заданиях. После слияния в `main` образы опубликованы.

## 17. План 6: резервное копирование и гигиена CI

### 17.1 Согласованность без остановки API
- Бэкап состоит из дампа базы `app` и архива тома `storage`. Удаление файла между дампом и архивом сломало бы ссылку из дампа. Новые файлы безопасны: в архиве они просто окажутся сиротами.
- `Storage.remove` проходит через шлюз. Он берёт `pg_advisory_lock_shared(726100001)` на отдельном соединении пула, удаляет и отпускает блокировку. Запись и чтение через шлюз не идут.
- Бэкап держит `pg_advisory_lock(726100001)` всё время, пока идут дамп и архив. Удаления на это время ждут. Чтение, генерация и сохранение продолжают работать.
- Ключ `726100001` — общая константа API и скрипта бэкапа.

### 17.2 Сервис `backup`
- Сервис compose в профиле `backup`, образ `postgres:17-alpine`. Скрипты лежат в `docker/backup/` и монтируются только для чтения. Хранилище монтируется в `/data` только для чтения, каталог бэкапов — `${BACKUP_DIR:-./backups}:/backups`.
- Расписание задаёт busybox `crond` по `BACKUP_CRON` (по умолчанию `0 3 * * *`). Хранятся последние `BACKUP_KEEP` копий (по умолчанию 14).
- Ручной запуск: `docker compose --profile backup run --rm backup now`.
- Один запуск:
  1. каталог `backups/<UTC ISO, двоеточия заменены на ->.partial/`;
  2. в одной сессии `psql`: `pg_advisory_lock`, затем `pg_dump -Fc` в `db.dump`, затем `tar -czf storage.tar.gz -C /data .`, затем unlock;
  3. `manifest.txt`: время, последняя миграция из `drizzle.__drizzle_migrations`, размеры, sha256 обоих файлов;
  4. переименование без `.partial`;
  5. удаление старых копий сверх `BACKUP_KEEP`. Удаляются только каталоги без `.partial`, подходящие под шаблон имени.
- При ошибке на любом шаге каталог `.partial` остаётся для разбора, а выход ненулевой. Лог пишется в stdout контейнера.

### 17.3 Восстановление
`scripts/restore.sh <каталог>` запускается на хосте и требует ввести слово `restore`. Шаги:
1. проверка sha256 из manifest;
2. `docker compose stop api web`;
3. `pg_restore --clean --if-exists --single-transaction --no-owner -d app`;
4. очистка и распаковка тома `storage` одноразовым контейнером с томом на запись;
5. `docker compose start api web` и ожидание healthy.

`.env` (`ENCRYPTION_KEY`, секреты) и `certs/` в бэкап не входят. README требует хранить их отдельно.

### 17.4 Гигиена CI
- Все `uses:` закреплены по SHA с комментарием версии. Используются актуальные мажорные версии, предупреждений о Node 20 нет.
- `.github/dependabot.yml`: `github-actions` еженедельно; `npm` ежемесячно с группировкой минорных и патч-обновлений.
- Триггеры: `push` в `main` и на семверные теги, `pull_request` в `main`, `workflow_dispatch`. Двойных прогонов нет. Ветку без PR можно проверить вручную: `gh workflow run ci.yml --ref <ветка>`.

## 18. План 7: SQL-параметры с зависимостями

### 18.1 Модель
- Новый тип параметра `query` («SQL-список») с полями `sql` (запрос к источнику данных шаблона) и `multiple` (множественный выбор). `options` у него не используется (`null`).
- Результат SQL — колонки `value` и `label`. Если колонка одна, она служит и значением, и подписью. Если колонок две и больше, но нет `value`/`label`, берутся первые две. Значение варианта — `string | number`, как пришло из базы; подпись приводится к строке.
- `ParamValue` расширяется массивами `(string | number)[]`. Одиночный `query`-параметр принимает `string | number`, множественный — непустой массив, либо пустое значение, если параметр не обязателен. В SQL отчёта массив передаётся как массив Postgres, например `where id = any(:ids)`.
- Зависимости — имена `:param` в `sql`, разобранные тем же парсером, что и SQL отчёта. При сохранении (`PUT params`) проверяется:
  - все ссылки ведут на существующие параметры;
  - параметр не ссылается на себя;
  - в зависимостях нет циклов.

  Ошибка возвращается как VALIDATION с путём `<i>.sql`.
- В БД (`template_params`) добавляются колонки `sql text null` и `multiple boolean not null default false`.

### 18.2 Выполнение
- Запрос вариантов выполняется на источнике шаблона в read-only транзакции с тем же таймаутом, что у запросов отчёта. Лимит — 1000 вариантов. Если вариантов больше, ошибка `TOO_MANY_OPTIONS` (400): «параметр "<label>": больше 1000 вариантов — уточните запрос».
- `POST /api/templates/:id/params/:name/options`, тело `{ params }` (текущие значения формы):
  - родители проверяются по типу;
  - если обязательный родитель пуст, ответ `{ options: [], waitingFor: [<имена>] }`;
  - иначе ответ `{ options }`.

  Доступ — как к генерации отчёта.
- **Строгая проверка** при генерации и предпросмотре:
  1. параметры проверяются по типу;
  2. SQL-параметры обходятся в порядке зависимостей, все в одной read-only транзакции;
  3. запрос каждого из них выполняется с уже проверенными значениями;
  4. выбранное значение (каждый элемент массива) должно быть среди вариантов. Значения сравниваются после приведения к строке, иначе ошибка VALIDATION у поля: «значение недоступно».

  Значение по умолчанию проверяется так же, но только при генерации.

### 18.3 Интерфейс
- **Форма отчёта.** SQL-параметр отображается как `Select` с поиском, при `multiple` — с множественным выбором.
  - Варианты загружаются запросом `options` и кэшируются по значениям родителей.
  - Пока родитель не заполнен, поле неактивно и показывает «сначала выберите: <подписи>».
  - При смене вариантов значения, которых больше нет в списке, сбрасываются.
- **Редактор, вкладка «Параметры».** Тип «SQL-список» показывает:
  - редактор SQL (Monaco);
  - флажок «множественный выбор»;
  - строку «зависит от: …»;
  - кнопку «Проверить», которая выполняет `options` с тестовыми параметрами и показывает варианты или ошибку.

## 19. План 8: группы и доступ к отчётам

### 19.1 Модель
- `groups` (название уникальное, описание) и `user_groups` (пользователь ↔ группа, многие ко многим).
- `categories` (название уникальное, порядок, `public`). У шаблонов появляются `category_id` (необязательный, при удалении категории ставится null) и `public`.
- Доступ групп задают `category_groups` (группа → категория) и `template_groups` (группа → шаблон).
- **Правило.** Админ видит всё. Пользователь видит шаблон, если выполнено хотя бы одно:
  - `template.public`;
  - `category.public`;
  - его группа есть в `category_groups` категории шаблона;
  - его группа есть в `template_groups` шаблона.
- **Миграция.** Все существующие шаблоны получают `public = true`. Новые создаются с `public = false`.

### 19.2 Применение
- Проверка доступа реализована в одном месте (`accessibleTemplates` — фильтр списка; `assertTemplateAccess` — карточка, рендер, опции).
- Она применяется к:
  - списку и карточке шаблона (недоступный шаблон отдаёт 404);
  - генерации;
  - вариантам SQL-параметров.
- Админские операции не меняются.
- История: пользователь видит свои прошлые запуски и скачивает их файлы, даже если доступ к шаблону отозван.

### 19.3 Интерфейс
- **Страница «Группы».** Список групп, создание, переименование, удаление, состав участников.
- **Страница «Категории».** Список категорий, порядок, флаг «доступно всем», группы с доступом.
- **Вкладка «Настройки» шаблона.** Категория, флаг «доступно всем», группы с точечным доступом.
- **Диалог пользователя.** Группы пользователя.
- **Каталог отчётов.** Сгруппирован по категориям в их порядке, шаблоны без категории — в разделе «Прочие».

## 20. План 9: Redis, общий срок отчёта, доработки

### 20.1 Redis
- Сервис `redis`:
  - образ `redis:7-alpine`, только во внутренней сети;
  - без снимков на диск (`--save "" --appendonly no`);
  - `--maxmemory 128mb --maxmemory-policy volatile-lru`;
  - healthcheck `redis-cli ping`.

  `api` стартует после того, как Redis станет healthy. Адрес задаёт `REDIS_URL` (по умолчанию `redis://redis:6379`), клиент — `ioredis`.
- **Лимит попыток входа** хранится в Redis: `@fastify/rate-limit` с опцией `redis`, ключ — логин в нижнем регистре, лимит прежний (10 в минуту). Если Redis недоступен, проверка пропускается (`skipOnError: true`) и в лог пишется предупреждение.
- **Кэш шаблонов Carbone** хранится в Redis:
  - ключ `cr:carbone:tpl:<templateId>`, значение — JSON `{version, carboneId}`, срок жизни 7 дней;
  - если Redis недоступен, чтение кэша считается промахом, а ошибка записи игнорируется: шаблон просто загружается в Carbone заново;
  - логика «Template not found → повторная загрузка» не меняется.
- Прочее состояние в памяти процесса не меняется: пулы источников — это соединения, и в Redis им не место.

### 20.2 Общий срок формирования отчёта
- `REPORT_TIMEOUT_MS` (по умолчанию 120000) задаёт срок генерации и предпросмотра от начала обработки запроса. Срок охватывает строгую проверку параметров, SQL и Carbone.
- Таймауты SQL и Carbone ограничены остатком срока: `min(QUERY_TIMEOUT_MS, остаток)`, `min(RENDER_TIMEOUT_MS, остаток)`.
- При исчерпании срока ответ — `AppError('TIMEOUT', 504, 'превышено время формирования отчёта')`, а в истории остаётся запуск со статусом error.

### 20.3 Форма отчёта
- Если родитель SQL-параметра — текстовое или числовое поле, варианты запрашиваются через 400 мс после последнего изменения (debounce).
- Пока загружаются варианты хотя бы одного SQL-параметра, кнопка «Сформировать» неактивна и рядом показан текст «Загружаются варианты параметров…».
- В истории запусков массивы показываются как «1, 2» в «ёлочках», чтобы их было видно на фоне разделителя параметров.

### 20.4 Бэкап и CI
- В режиме `cron` сервис `backup` проверяет `BACKUP_CRON`: ровно 5 полей, без перевода строки. Иначе выход с кодом 2 и сообщением «BACKUP_CRON: ожидается 5 полей cron».
- `pg_dump` и `tar` выполняются под `timeout ${BACKUP_TIMEOUT:-3600}`. Превышение считается сбоем: остаётся `.partial`, выход ненулевой, блокировка снимается.
- `dependabot.yml`: для npm игнорировать мажорные обновления `typescript`.

## 21. План 10: защита Redis и лимиты входа

### 21.1 Redis
- `REDIS_PASSWORD` — обязательная переменная (hex, `openssl rand -hex 32`). Redis запускается с `--requirepass "$REDIS_PASSWORD"`. API подключается по `redis://:<пароль>@redis:6379`: `REDIS_URL` собирается в compose. Healthcheck и `scripts/restore.sh` передают пароль через `REDISCLI_AUTH`, а не аргументом.
- Сеть `cache` (`internal: true`) объединяет только `redis` и `api`. Redis не подключён к сети по умолчанию.
- Если `REDIS_PASSWORD` не задан, compose прерывается с сообщением «задайте REDIS_PASSWORD в .env».

### 21.2 Запасной лимит
- Собственное хранилище для `@fastify/rate-limit` (`store`): основное хранение в Redis. При ошибке Redis тот же запрос учитывается в памяти процесса — лимит продолжает действовать, но по каждому экземпляру API отдельно.
- После ошибки хранилище 5 секунд не обращается к Redis («автомат»), затем пробует снова. `skipOnError` больше не используется.

### 21.3 Лимит по IP
- Помимо лимита по логину (10 в минуту), вход ограничен по IP клиента: 30 попыток в минуту, пространство ключей `cr:rl-ip:`, то же хранилище с запасным в памяти.
- При превышении — 429 `TOO_MANY_ATTEMPTS` «слишком много попыток входа с этого адреса, повторите через минуту».
- IP клиента берётся из `X-Forwarded-For`, который добавляет nginx. Fastify создаётся с доверием ровно одному хопу (функция `trustProxyHops`; число в `trustProxy` в Fastify 5 означает fail-closed), поэтому заголовок, подделанный клиентом, на адрес не влияет.

## 22. План 11: гигиена

### 22.1 Пароль Redis
- Контейнер `redis` до запуска сервера проверяет `REDIS_PASSWORD`: допустимы только `0-9a-f` (без учёта регистра). Иначе он выходит с ненулевым кодом и сообщением «REDIS_PASSWORD: только шестнадцатеричные символы (openssl rand -hex 32)». `api` ждёт `redis` в состоянии healthy, поэтому стек не поднимается. Причина видна в журнале `redis`.

### 22.2 Тест блокировки в callback OnlyOffice
- Тест «callback не держит блокировку строки во время скачивания» не опирается на время. Заглушка `fetchFile` для отдельного URL сообщает, что скачивание началось, и ждёт сигнала теста.
- Тест проверяет порядок событий: дождаться начала скачивания → PATCH шаблона завершается (200), пока скачивание не отпущено → отпустить → callback 200, версия +1. Остальные тесты с `slow` не меняются.

### 22.3 Favicon
- `apps/web/public/favicon.svg` (иконка-документ), `<link rel="icon" type="image/svg+xml" href="/favicon.svg">` в `index.html`.
- nginx: `location = /favicon.ico { return 404; }`, вместо `index.html`.

### 22.4 «Отменить» в редакторе шаблона
- Вкладки «Настройки», «Данные» и раздел «Доступ» ведут себя как «Параметры»:
  - при изменениях показывается «Есть несохранённые изменения» и кнопка «Отменить» (сброс к последнему сохранённому состоянию шаблона);
  - кнопка сохранения неактивна без изменений.

### 22.5 Порт источника данных
- В форме источника поле «Порт» можно очистить, оно не подставляет 5432 само. У нового источника по-прежнему 5432.
- Пустой порт при сохранении даёт ошибку у поля «укажите порт», запрос не отправляется.

### 22.6 Раздел «Без категории»
- В каталоге отчётов шаблоны без категории собираются в раздел «Без категории», он стоит последним. Название «Прочие» — обычное имя категории.

### 22.7 Повторная ошибка сохранения OnlyOffice
- Новая колонка `templates.last_save_error_at timestamptz null` пишется вместе с `last_save_error`. При успешном сохранении и замене файла оба поля обнуляются. `TemplateAdminDetails.lastSaveErrorAt: string | null` (ISO).
- Вкладка «Документ» считает ошибку новой, если `lastSaveErrorAt` отличается от значения до сохранения. Текст ошибки не сравнивается. Повторная ошибка с тем же текстом показывается как «Сохранение не удалось», а не как предупреждение о таймауте.

### 22.8 Monaco
- Вместо `monaco-editor` целиком подключаются `editor.api`, язык SQL (`basic-languages/sql`) и JSON (`language/json`) с его воркером. Используемые языки — только `sql` и `json`.
- Размер `dist/assets` замеряется до и после, результат записывается в заметки. `chunkSizeWarningLimit` снижается до замеренного размера самого большого чанка с округлением вверх.
- Подсветка SQL и JSON и работа редактора под строгой CSP проверяются в E2E.

## 23. План 12: справка по синтаксису шаблонов

Источник фактов: `docs/superpowers/notes/2026-10-13-carbone-community-matrix.md`. Это матрица проверки примерно 200 проб на нашем Carbone `carbone-ee:full-5.15.3-fonts` без лицензии; журнал запуска Carbone — «templating: Basic (Community Edition)». В справке есть только то, что матрица подтверждает. Всё, чего в бесплатной версии нет, вынесено в отдельный раздел.

### 23.1 Страница
- Маршрут `/admin/help`, заголовок «Справка по шаблонам». Доступна только админам; у пользователя без прав админа маршрут ведёт себя так же, как другие админские страницы. Пункт «Справка по шаблонам» стоит в меню администрирования.
- В редакторе шаблона рядом с панелью «Теги» есть ссылка «Справка по синтаксису». Она открывает `/admin/help` в новой вкладке (`target="_blank"`, `rel="noopener"`), поэтому документ в OnlyOffice остаётся открытым.
- Слева оглавление по разделам (якоря), справа содержание. Пример показывается карточкой: заголовок, «Тег в шаблоне» (моноширинный текст и кнопка «Копировать»), «Данные» (JSON), «Результат» и, при необходимости, заметка «Внимание».

### 23.2 Разделы
1. **Основы.** `{d.поле}`, вложенные объекты, параметры отчёта `{d.params.…}` (из `{c.…}` система передаёт только `{c.now}`), `ifEmpty('—')` (ставится последним в цепочке), алиасы `{#…}`.
2. **Таблицы.** Строки из массива `[i]`/`[i+1]`; вложенные таблицы; пустой массив — строки исчезают без ошибки; нумерация `{d.x[i].поле:print(.i):add(1)}` (внутри отфильтрованного цикла номера идут с пропусками); отбор строк `[i, поле=значение]`; сортировка только по возрастанию.
3. **Форматирование.**
   - Даты: `formatD`. Время без смещения UTC считается временем UTC, поэтому время нужно передавать со смещением.
   - Числа: `formatN`.
   - Деньги: `formatC` в рублях, `convCurr` со встроенными курсами.
   - Строки и простая математика.
4. **Условия.** `ifEQ`/`ifGT`/… с `show`/`elseShow`, `and`/`or`, `showBegin`/`hideBegin` для абзацев и текста. Строку таблицы скрывают только фильтром цикла: `hideBegin` в таблице оставляет пустую строку.
5. **Итоги и группировка.**
   - Агрегаторы (`aggSum`, `aggCount`, `cumSum`, `:count()` и др.) в бесплатной версии отключены. Итоги, подытоги, нумерацию и группировку считают в SQL.
   - Готовые SQL-примеры: `sum()`/`count()` отдельным запросом в режиме `single`, `row_number() over (...)`, сгруппированный JSON через `json_agg`.
   - Группировка через `:set` работает, но суммировать через `:set` нельзя: итог получается неверным.
6. **Недоступно в бесплатной версии.** Агрегаторы, `drop`/`keep`, `html`, `color`/`bindColor`, `barcode`, `chart`, изображения, `formatR`, `autoOrient`, `defaultURL`, сортировка по убыванию, вывод TXT с кириллицей. Для каждого пункта указано, что сделать вместо него.

### 23.3 Хранение и проверка содержания
- Содержание хранится в типизированном модуле веба: разделы → примеры `{ id, title, template, data, result, note? }`. Его отображает общий компонент. Новых зависимостей нет.
- Модульный тест проверяет, что у каждого примера `data` — корректный JSON, `id` уникальны, а каждый раздел оглавления существует.
- Скрипт `scripts/help-check.ts` (`pnpm help:check`) строит для каждого примера минимальный DOCX с тегом и рендерит его через Carbone так же, как API: тот же `lang`, `timezone` и т. п. Затем он сравнивает текст результата с полем `result` и выходит с ненулевым кодом при расхождении. Скрипт запускается в живом прогоне на демо-стеке, в CI его нет. Примеры из раздела 6 помечены как недоступные: для них скрипт проверяет, что Carbone возвращает ошибку «disabled in the Community Edition».

### 23.4 Правки API
- Рендер передаёт Carbone `lang: 'ru'` вместо `'ru-ru'`. Тогда `formatN` даёт `1 234 567,89`, а `formatC` — сумму в рублях. Даты не меняются. Если где-то используется ключ переводов `ru-ru`, он меняется на `ru`.
- Ошибка Carbone вида «Formatter "X" is disabled in the Community Edition» при генерации и предпросмотре превращается в `AppError('CARBONE_COMMUNITY', 400, 'в шаблоне используется X — недоступно в бесплатной версии Carbone, см. «Справка по шаблонам»')`. Имя форматтера берётся из ответа. Если его разобрать не удалось, вместо имени пишется «форматтер». Другие ошибки Carbone обрабатываются по-прежнему.

### 23.5 Проверки
- Веб: страница отображает все разделы и оглавление; ссылка в редакторе ведёт на `/admin/help` в новой вкладке; не-админ на `/admin/help` не попадает.
- API: тест сопоставления ошибки Community; тест, что в рендер уходит `lang: 'ru'`.
- E2E: админ открывает справку по ссылке из редактора и видит разделы.
- Живой прогон: `pnpm help:check` без расхождений.

## 24. План 13: просмотр отчёта перед сохранением

### 24.1 Процесс для пользователя
- На странице запуска отчёта выбора формата больше нет. Кнопка «Сформировать» формирует отчёт и показывает его в PDF на странице.
- Под просмотром — «Сохранить как» с кнопкой для каждого формата из `outputFormatsFor(fileExt)`:
  - Word-шаблон: PDF, DOCX, ODT;
  - Excel-шаблон: PDF, XLSX, ODS;
  - PowerPoint: PDF, PPTX.
- Формат по умолчанию из настроек шаблона (`defaultOutput`) — основная кнопка, остальные второстепенные.
- Просмотр всегда в PDF, для Excel тоже (печатный вид по настройкам печати шаблона).
- Повторное «Сформировать» создаёт новый запуск и новый просмотр.

### 24.2 Снимок запуска
- «Сформировать» один раз собирает данные отчёта (проверка параметров, SQL — как сейчас) и сохраняет снимок запуска в хранилище:
  - данные — `reports/<runId>/data.json`;
  - копия файла шаблона той версии, что использовалась, — `reports/<runId>/template.<ext>`.
- Из снимка собирается PDF: `reports/<runId>/out.pdf`. Ответ — `201 { runId }`, как сейчас.
- Файл формата F собирается из снимка (данные и копия шаблона) при первом запросе и сохраняется как `reports/<runId>/out.<F>`. Дальше отдаётся готовым. Повторной выборки данных нет, поэтому файл совпадает с просмотром, даже если данные или шаблон с тех пор изменились.
- Одновременные запросы одного формата одного запуска собирают файл один раз: блокировка на время сборки, второй запрос ждёт и получает готовый файл.
- Сборка из снимка укладывается в общий срок `REPORT_TIMEOUT_MS`, отсчитываемый от начала запроса на скачивание.
- В Carbone копия шаблона загружается как обычный шаблон. Кэш идентификатора шаблона Carbone для снимка ключуется по `runId`, а не по шаблону.

### 24.3 Модель данных
- `report_runs.output_format` становится необязательным: у новых запусков формата запуска нет, есть набор собранных файлов. В `report_runs` добавляется `snapshot boolean not null default false`.
- Новая таблица `report_run_files(run_id uuid → report_runs on delete cascade, format text, file_path text, created_at timestamptz, primary key (run_id, format))` — собранные файлы.
- Старые запуски (`snapshot = false`) не меняются. Их единственный файл доступен в формате `output_format`, другие форматы для них недоступны.

### 24.4 API
- `POST /api/reports/:id/render` — тело `{ params }`, формат больше не передаётся. Если `format` всё же пришёл, он игнорируется. Ответ — `201 { runId }` после сборки PDF.
- `GET /api/runs/:id/file?format=<F>&inline=0|1`:
  - отдаёт файл формата F, при необходимости собрав его из снимка;
  - без `format` — PDF для снимковых запусков и `output_format` для старых;
  - формат вне `outputFormatsFor(ext)`, а для старых запусков — любой, кроме `output_format`, даёт 400 VALIDATION «формат недоступен для этого отчёта»;
  - снимок удалён — 410 GONE «файл удалён — сформируйте отчёт заново»;
  - ошибка сборки (в том числе `CARBONE_COMMUNITY`) возвращается как есть, статус запуска не меняется.
- `GET /api/runs` — у каждого запуска `formats: OutputFormat[]` (доступные для скачивания) и `readyFormats: OutputFormat[]` (уже собранные). `fileAvailable` остаётся для совместимости.
- Доступ к файлам — как сейчас: владелец или админ, иначе 404. Снимок данных наружу не отдаётся.

### 24.5 Очистка и удаление
- Очистка по `REPORT_RETENTION_DAYS` удаляет весь каталог `reports/<runId>/` и строки `report_run_files` и ставит `file_deleted = true`. Для старых запусков — как сейчас.
- Удаление пользователя удаляет каталоги его запусков.

### 24.6 Интерфейс
- **ReportRunPage.**
  - Форма параметров и «Сформировать».
  - После успеха: просмотр PDF в `iframe` (`/api/runs/:id/file?format=pdf&inline=1`) и ряд кнопок «Сохранить как».
  - Пока файл собирается, у нажатой кнопки виден спиннер. Ошибка сборки показывается под кнопками.
  - Скачивание — тот же механизм `triggerDownload`.
- **HistoryPage.** У успешного запуска со снимком — меню «Скачать» со всеми форматами из `formats`. У старых — одна ссылка, как сейчас.
- Предпросмотр админа на вкладке «Предпросмотр» редактора не меняется.

### 24.7 Проверки
- **API, интеграционные тесты:**
  - запуск создаёт снимок и PDF;
  - DOCX/XLSX собираются по требованию из снимка;
  - после изменения данных в источнике и замены шаблона файл собирается из снимка (данные и шаблон те же);
  - два одновременных запроса формата — одна сборка;
  - недопустимый формат — 400;
  - старый запуск — только его формат;
  - очистка удаляет каталог;
  - чужой запуск — 404.
- **Веб:** кнопки форматов для Word- и Excel-шаблона, основная кнопка по `defaultOutput`, состояние сборки и ошибка, меню форматов в истории.
- **E2E:** «Сформировать» → виден PDF → «Сохранить как DOCX» скачивает файл. На демо-стеке.

## 25. План 14: хранилище S3

Цель — хранить файлы приложения (шаблоны, снимки запусков, результаты) в S3-совместимом хранилище, чтобы несколько экземпляров API работали без общего тома. Это подготовка к Helm-чарту (План 15).

### 25.1 Интерфейс и реализации
- Файлы в API используются только через `Storage`. Он становится интерфейсом с двумя реализациями:
  - `local` — текущее поведение на диске;
  - `s3` — на `@aws-sdk/client-s3`.
- Методы: `read`, `write`, `remove`, `removeUngated`, `exists`. Метод `path()` удаляется: у него нет вызовов.
- Настройки:
  - `STORAGE_BACKEND=local|s3`, по умолчанию `local`;
  - для `s3`: `S3_ENDPOINT` (необязателен для AWS), `S3_REGION` (по умолчанию `us-east-1`), `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` (по умолчанию `false`, для SeaweedFS `true`), `S3_CREATE_BUCKET` (по умолчанию `false`).

  Если `STORAGE_BACKEND=s3`, а обязательные значения не заданы, конфигурация не проходит проверку с понятной ошибкой.
- При старте с `s3` API проверяет бакет (HeadBucket). Если бакета нет и `S3_CREATE_BUCKET=true`, API создаёт его. Если бакета нет и `S3_CREATE_BUCKET=false`, API не запускается с ошибкой «бакет S3_BUCKET не найден». Секреты в журнал не попадают.

### 25.2 Поведение S3
- **Ключи.** Ключ — относительный путь, например `templates/<id>/v3.docx`. Пустой ключ, ведущий `/`, сегменты `.` и `..` и обратная косая черта запрещены — та же ошибка, что сейчас у выхода за корень.
- **Запись** — один `PutObject`; он атомарен, временных объектов нет.
- **Чтение** — `GetObject` целиком в `Buffer`. Отсутствующий ключ даёт ошибку с `code = 'ENOENT'`, как на диске, поэтому 410 и запасной путь чтения шаблона работают без изменений.
- **`exists`** — `HeadObject`; 404 означает `false`.
- **`remove(key)`:**
  - удаляет объект `key` и все объекты с префиксом `key + '/'`;
  - объекты перечисляются постранично и удаляются пачками `DeleteObjects` до 1000;
  - отсутствие объектов — не ошибка.

  `remove` проходит через блокировку удалений на время бэкапа, `removeUngated` — без неё. Всё как сейчас.
- **Сетевые ошибки** S3 поднимаются как есть. Повторы делает SDK со стандартной политикой.

### 25.3 Бэкап и восстановление
- В образ сервиса `backup` добавляется `rclone` (`apk add rclone`). Настройки S3 передаются ему переменными окружения, без файла конфигурации с секретами.
- Режим `s3`:
  1. Под той же исключительной блокировкой: `pg_dump`.
  2. `rclone copy` бакета во временный каталог.
  3. `tar` этого каталога в `storage.tar.gz` — формат, манифест и контрольные суммы прежние.
  4. Временный каталог удаляется.
- Режим `local` не меняется. Режим определяется по `STORAGE_BACKEND` сервиса `backup`.
- Восстановление в режиме `s3`: проверка архива, как сейчас, затем распаковка во временный каталог и `rclone sync` в бакет. Объекты, которых нет в архиве, удаляются. `scripts/restore.sh` выбирает ветку по `STORAGE_BACKEND`.
- Перенос существующей установки с диска на S3 делается через бэкап и восстановление: формат архива одинаков для обоих режимов. Отдельной команды переноса нет.

### 25.4 docker compose
- Новый сервис `s3` — SeaweedFS (официальный образ `chrislusf/seaweedfs`), S3-шлюз в одном контейнере:
  - образ с закреплённой версией, том `s3_data`;
  - только во внутренней сети вместе с `api` и `backup`; консоль и порт наружу не публикуются;
  - `S3_ACCESS_KEY_ID` и `S3_SECRET_ACCESS_KEY` обязательны в `.env` (`:?` с сообщением, как у `REDIS_PASSWORD`); из них при старте контейнера создаётся единственная учётная запись S3, секретов в репозитории нет; healthcheck.
- `api`: `STORAGE_BACKEND=s3`, `S3_ENDPOINT=http://s3:8333`, `S3_FORCE_PATH_STYLE=true`, `S3_CREATE_BUCKET=true`, `S3_BUCKET` (по умолчанию `carbone-reports`). Зависит от healthy `s3`. Ключи — те же `S3_ACCESS_KEY_ID` и `S3_SECRET_ACCESS_KEY`. Том `storage` у `api` больше не монтируется.
- `backup` получает те же настройки S3.
- README описывает новые переменные, перенос через бэкап и восстановление и то, что существующий том `storage` после переноса можно удалить вручную.

### 25.5 Проверки
- **Контрактные тесты** `Storage`: один набор прогоняется на `local` и на `s3` (SeaweedFS в testcontainers, тот же образ). Проверяются чтение и запись, `ENOENT`, `exists`, удаление ключа и префикса (больше 1000 объектов — постраничность), отклонение недопустимых ключей и блокировка удалений.
- **Интеграционные тесты на `s3`:**
  - создание шаблона;
  - сохранение из OnlyOffice, новая версия;
  - формирование отчёта и сборка DOCX из снимка;
  - очистка;
  - удаление пользователя;
  - проверка бакета при старте: создание и ошибка при отсутствии.
- **Живой прогон** стека с SeaweedFS: миграции, smoke, E2E дважды, бэкап и восстановление. После восстановления файлы снова в бакете, отчёт формируется, шаблон открывается.

## 26. План 15: управление бэкапами из админки

Цель — дать администратору прямо в веб-интерфейсе:
- видеть список бэкапов;
- запускать бэкап;
- восстанавливать данные из выбранного бэкапа.

Всё это без доступа к хосту. `scripts/restore.sh` остаётся аварийным путём.

Не входит в план:
- скачивание, загрузка и ручное удаление бэкапов;
- восстановление в k8s — это План 16.

### 26.1 Агент бэкапа (`apps/backup-agent`)
- **Что это.** Новый пакет на TypeScript и Fastify, который работает внутри образа сервиса `backup`. Образ — `postgres:17-alpine`, `rclone` и Node.
- **Скрипты.** Агент вызывает существующие скрипты как дочерние процессы и не переписывает их: `backup.sh`, `archive-storage.sh` и режим `restore-storage` из `entrypoint.sh`.
- **Расписание.** Бэкап по расписанию запускает сам агент: значение `BACKUP_CRON` с прежней проверкой «ровно 5 полей», часовой пояс `TZ`. Отдельного `crond` больше нет.
- **Сеть.** HTTP слушает порт `8080`, только во внутренней сети `backup` между api и backup. Публикуемых портов нет.
- **Авторизация.** Каждый запрос, кроме `GET /health`, требует `Authorization: Bearer <BACKUP_AGENT_TOKEN>`. Сравнение выполняется за постоянное время. Без токена из 32 и более символов агент не стартует.
- **Одна операция за раз.** Это обеспечивают замок в процессе и `flock` на `/backups/.op.lock`. Через тот же `flock` проходит `entrypoint.sh now`, то есть ручной `docker compose run backup now`.
  - Если запрос пришёл во время другой операции, агент отвечает 409 с телом `{ busy: { type, startedAt } }`.
  - Если `flock` не взят к моменту срабатывания cron, запуск по расписанию пропускается с записью в журнал.
- **Эндпоинты:**
  - `GET /backups` — каталоги из `/backups`, новые сверху. Поля: `name`, `createdAt`, `dbSize`, `storageSize`, `lastMigration`, `kind` (`regular` | `pre-restore`), `status` (`ok` | `partial`). Каталоги `*.partial` получают `status: partial`.
  - `POST /backups` — запуск бэкапа. Ответ 202 `{ operationId }`.
  - `POST /backups/:name/restore` — запуск восстановления. Ответ 202 `{ operationId }`.
    - Имя проверяется по шаблону `^(pre-restore-)?\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$`, каталог должен существовать.
    - Запрос принимает поле `requestedBy` (логин) — только для журнала.
  - `GET /operation` — текущая или последняя операция. Поля: `id`, `type` (`backup` | `restore`), `requestedBy` (`cron` | логин), `phase`, `status` (`running` | `succeeded` | `failed`), `startedAt`, `finishedAt`, `error`, `log` (хвост до 500 строк), `recovery` (`{ backup, preRestore }` или `null`).
  - `POST /recovery {code, target}` — см. 26.4.
- **Журнал операции.** Пишется в `/backups/.op/<id>.log`, хранятся последние 20 журналов.
  - Из вывода дочерних процессов вырезаются значения переменных окружения, содержащих `PASSWORD`, `SECRET`, `TOKEN` и `KEY`, длиной от 6 символов.
- **Ротация.** `BACKUP_KEEP` действует только на обычные бэкапы. Бэкапы `pre-restore-*` ротируются отдельно: хранятся последние 3.

### 26.2 Восстановление
**Состояние.** Агент ведёт восстановление и записывает каждую смену фазы в `/backups/.op/state.json` атомарно, через временный файл и `rename`.

**Фазы:**
1. **`verify`** — ничего не меняется:
   - `db.dump`, `storage.tar.gz` и `manifest.txt` есть, sha256 совпадают;
   - `last_migration` бэкапа есть среди хешей встроенных в агент миграций. Агент собирается из того же коммита, что и API, и несёт `apps/api/drizzle`. Иначе отказ «бэкап создан более новой версией приложения»;
   - S3 читается (`rclone lsf`), если `STORAGE_BACKEND=s3`.
2. **`pre-backup`** — обычный бэкап в каталог `pre-restore-<время>`. При ошибке восстановление отменяется.
3. **`maintenance`** — включение режима обслуживания:
   - в Redis записывается `cr:maintenance` = `{ phase, startedAt, backup }`, без TTL;
   - через 3 с агент вызывает `pg_terminate_backend` для сессий с `application_name = 'api'`. Пулы API переподключаются сами.
   - Пул API задаёт `application_name: 'api'`. Это часть плана: сейчас имя приложения не задаётся.
   - Redis в стеке работает без персистентности. Поэтому, пока `state.json` требует обслуживания (фазы 3–7 или состояние «требуется восстановление»), агент каждые 5 с перезаписывает `cr:maintenance`. Флаг возвращается и после рестарта Redis.
4. **`db`** — замена базы одной транзакцией: удаляются схемы `drizzle` и `public`, затем выполняется SQL из `pg_restore -f`. Так же, как в `restore.sh`.
5. **`migrate`** — миграции drizzle из встроенной папки доводят старый бэкап до текущей схемы.
6. **`storage`** — `restore-storage` (`rclone sync` или распаковка).
7. **`redis`** — удаляются все ключи, кроме `cr:maintenance`. Удаление идёт через `SCAN` и `UNLINK`.
8. **`done`** — `cr:maintenance` снимается, операция получает статус `succeeded`.

Значение `cr:maintenance.phase` обновляется на каждой фазе 3–7.

**Если агент перезапустился посреди операции** — после рестарта он видит в `state.json` незавершённое восстановление:
- на фазах 1–3 до замены базы: операция помечается `failed`, флаг снимается;
- на фазах 4–7: переход в состояние «требуется восстановление», см. 26.4.

**Пользователи после восстановления.** Пользователь и версия его сессий проверяются по базе. Поэтому после восстановления может понадобиться войти заново, в том числе админу.

### 26.3 API и режим обслуживания
**Конфигурация:**
- `BACKUP_AGENT_URL` (например, `http://backup:8080`) и `BACKUP_AGENT_TOKEN`.
- Без них функция выключена: `/api/admin/backups*` отвечает 404 с кодом `backups_disabled`, а пункта меню нет. Признак включения приходит в `/api/auth/me` или в конфиге клиента.

**Модуль `backups`, только роль admin:**
- `GET /api/admin/backups` проксирует `GET /backups`.
- `POST /api/admin/backups` проксирует `POST /backups`.
- `POST /api/admin/backups/:name/restore` проксирует запрос с `requestedBy` равным логину текущего пользователя.
- `GET /api/admin/backups/operation` проксирует `GET /operation`.
- Таймаут запроса к агенту — 10 с. Если агент недоступен, ответ 502 с кодом `backup_agent_unavailable` и текстом «Агент бэкапа недоступен».
- API пишет в журнал, кто запустил бэкап или восстановление.

**Middleware обслуживания:**
- На каждый запрос API выполняет `GET cr:maintenance` в Redis. Значение кэшируется в процессе на 1 с.
- Пока ключ есть, все маршруты отвечают 503 с кодом `maintenance`, кроме:
  - `GET /api/health`;
  - `GET /api/maintenance`;
  - `POST /api/maintenance/retry`.
- Если Redis недоступен, API работает как обычно (fail-open): обслуживание включает только агент, и он всегда пишет флаг в Redis.

**Публичные эндпоинты:**
- `GET /api/maintenance` отвечает `{ active: false }` или `{ active: true, phase, startedAt, backup, recovery: { backup, preRestore } | null }`. Поле `recovery` берётся у агента и заполнено только в состоянии «требуется восстановление».
- `POST /api/maintenance/retry {code, target}` проксирует запрос в `POST /recovery`.
  - На этот эндпоинт действует лимит Redis — 10 запросов за 15 минут с одного IP.
  - Если Redis недоступен, лимит пропускается: защиту даёт ещё и лимит агента.

### 26.4 Повтор после сбоя
- **Код восстановления.** Если восстановление упало на фазах 4–7, флаг `cr:maintenance` остаётся. Агент генерирует код:
  - 12 символов base32 (`crypto.randomBytes`);
  - открыто печатает его в свой журнал (`docker compose logs backup`) строкой `КОД ВОССТАНОВЛЕНИЯ: XXXX-XXXX-XXXX`;
  - в `state.json` хранит только sha256 кода.
- **Экран обслуживания** показывает: «Восстановление не завершено: база частично заменена». Под текстом поле кода и две кнопки:
  - «Повторить восстановление из `<имя>`» (`target: "same"`);
  - «Вернуть состояние до восстановления (`pre-restore-…`)» (`target: "pre-restore"`).
- **`POST /recovery`.**
  - Верный код запускает восстановление выбранной цели с фазы `maintenance`, без нового `pre-backup`. Ответ 202.
  - Неверный код даёт 403. После 5 неверных попыток код сгорает, и агент печатает новый.
  - Если состояния «требуется восстановление» нет, ответ 409.
- **Новый код при каждом сбое.** Если повтор тоже упал, агент генерирует новый код.
- **Аварийный выход.** `scripts/restore.sh` останавливает сервис `backup` на время работы. Перед запуском агента скрипт помечает незавершённое восстановление в `/backups/.op/state.json` как `failed (resolved externally)`, а в конце делает `FLUSHALL` Redis. После этого агент не возвращает флаг обслуживания.

### 26.5 Web
- **Пункт «Бэкапы»** в админке: таблица бэкапов с колонками «Дата», «Тип», «Размер», «Миграция» и «Статус». Над ней кнопка «Сделать бэкап».
- **Панель операции.** Показывает текущую или последнюю операцию: тип, кто запустил, фазу, статус и журнал в свёрнутом блоке. Пока операция `running`, панель опрашивается раз в 2 с.
- **«Восстановить»** в строке со статусом `ok`. Открывает диалог:
  - предупреждение: база и файлы будут заменены, перед восстановлением будет сделан бэкап, пользователей может разлогинить;
  - поле «Введите имя бэкапа для подтверждения».
  - Кнопка активна только при точном совпадении имени.
- **Экран обслуживания.** На ответ 503 с кодом `maintenance` web показывает экран на всю страницу: «Идёт восстановление из бэкапа…» и фазу.
  - Экран опрашивает `/api/maintenance` раз в 3 с.
  - Когда обслуживание закончилось, страница перезагружается.
  - В состоянии «требуется восстановление» показывается форма кода из 26.4.

### 26.6 docker compose
- **Сервис `backup`** выходит из профиля `backup` и запускается со стеком: `command: ['agent']`.
  - Сети: `default` для postgres, `s3`, `cache` для redis и новая внутренняя `backup`.
  - Новые переменные: `BACKUP_AGENT_TOKEN: ${BACKUP_AGENT_TOKEN:?…}`, `REDIS_URL` с паролем.
- **Сервис `api`** получает `BACKUP_AGENT_URL` и `BACKUP_AGENT_TOKEN` и подключается к сети `backup`.
- **Режимы `entrypoint.sh`:** `agent` (по умолчанию), `now`, `restore-storage`. Режим `cron` удаляется — расписание перешло в агент.
- **`.env.example` и README:** токен агента и раздел «Бэкапы в админке».

### 26.7 Тестирование
- **Агент, юнит-тесты:**
  - разбор `manifest.txt`;
  - проверка версии миграций;
  - фазы и `state.json`, включая возобновление после рестарта;
  - коды восстановления: генерация, хеш, лимит 5 попыток;
  - ротация с отдельным учётом `pre-restore`;
  - фильтр секретов;
  - разбор `BACKUP_CRON`.
- **Агент, интеграционные тесты** (testcontainers: postgres, redis, SeaweedFS):
  - бэкап и список;
  - восстановление бэкапа со старой схемой с донакаткой миграций;
  - отказ для бэкапа «из будущего»;
  - сбой на фазе `storage` → флаг остаётся → повтор по коду;
  - 409 при параллельной операции.
- **API:** прокси и права (не-admin — 403), `backups_disabled`, `backup_agent_unavailable`, middleware обслуживания (503, белый список, fail-open без Redis), `/api/maintenance` и лимит на `retry`.
- **Web:** страница «Бэкапы», диалог подтверждения, экран обслуживания и форма кода.
- **E2E:** бэкап из админки → изменение данных → восстановление → повторный вход → данные из бэкапа на месте.
- **Живой прогон в compose:** то же на реальном стеке, сбой с повтором по коду, `scripts/restore.sh` как аварийный путь.

## 27. План 16: Helm-чарт

Цель — разворачивать приложение в свой кластер Kubernetes командой `helm install`. Чарт ставит администратор кластера сам; публичный каталог чартов и OpenShift не цели.

Не входит в план:
- копии бэкапов вне кластера: снапшоты тома и Velero — средства кластера, чарт за них не отвечает;
- автоматическое масштабирование (HPA), Gateway API, OpenShift Routes;
- E2E Playwright в кластере в CI;
- скрипт аварийного восстановления для k8s — вместо него инструкция в README: восстановление через HTTP агента (27.5).

### 27.1 Состав чарта (`charts/carbone-reports`)
- Один чарт с обычными шаблонами, без подчартов. Имена ресурсов — `<fullname>-<компонент>`, где `fullname` — стандартный `<release>-carbone-reports` с усечением до 63 символов.

| Компонент | Ресурс | Реплики по умолчанию | Хранение |
|---|---|---|---|
| web | Deployment, Service :80 | 2 | — |
| api | Deployment, Service :3000, PodDisruptionBudget `minAvailable: 1` | 2 | — |
| carbone (`carbone.enabled`) | Deployment, Service :4000 | 1 | emptyDir `/app/template` |
| onlyoffice (`onlyoffice.enabled`) | StatefulSet, Service :80 | 1, не масштабируется | PVC `Data` и `lib` |
| агент бэкапа | Deployment `strategy: Recreate`, Service :8080 | 1 | PVC RWO `/backups` |
| postgres (`postgresql.enabled`) | StatefulSet, Service :5432 | 1 | PVC |
| redis (`redis.enabled`) | StatefulSet, Service :6379 | 1 | нет (как в compose: без персистентности) |
| s3 (`s3.enabled`, SeaweedFS) | StatefulSet, Service :8333 | 1 | PVC |

- Хранилище файлов в чарте — всегда S3 (`STORAGE_BACKEND=s3`): общего тома у реплик API нет.
- Встроенные postgres, redis и s3 по умолчанию выключены. Это те же образы и настройки, что в compose: `postgres:17-alpine`, `redis:7-alpine` с паролем и `--save ""`, `chrislusf/seaweedfs:4.48` с `docker/s3/entrypoint.sh`. Скрипт попадает в под через ConfigMap; его копия в чарте проверяется тестом на совпадение с `docker/s3/entrypoint.sh`. Встроенные зависимости — для пробной установки и проверки чарта; для прода — внешние.
- Выключенный встроенный компонент требует внешнего:
  - `externalDatabase`: хост, порт, база, пользователь, `sslMode`, необязательный CA из Secret;
  - `externalRedis`: URL без пароля и пароль из секрета;
  - `externalS3`: endpoint, регион, бакет, `forcePathStyle`, необязательные ключи;
  - `carbone.url`, `onlyoffice.internalUrl` при выключенных Carbone и OnlyOffice.
- Пропущенное обязательное значение — ошибка `helm install`/`helm template` с понятным текстом (`fail`/`required`), как `:?` в compose.

### 27.2 Вход и образ web
- Ingress (`ingress.enabled`, по умолчанию включён): `className`, `host`, `tls.secretName`, `annotations`. Все пути ведут на Service web:80. TLS завершает Ingress.
- В `values.yaml` — закомментированный пример аннотаций ingress-nginx: `proxy-body-size: 100m`, `proxy-read-timeout`/`proxy-send-timeout: 300`. Без них не работает загрузка в OnlyOffice; аннотации зависят от контроллера, поэтому только пример.
- Образ web получает конфигурацию nginx из шаблона `envsubst` (механизм `/etc/nginx/templates` официального образа):
  - `NGINX_MODE`: `tls` (по умолчанию, compose — как сейчас: 80 → 301, 443 с сертификатами и HSTS) или `http` (k8s: только `listen 80`, без редиректа; HSTS по-прежнему отдаётся, TLS — на Ingress);
  - `API_UPSTREAM` (по умолчанию `http://api:3000`) и `ONLYOFFICE_UPSTREAM` (по умолчанию `http://onlyoffice`);
  - адрес резолвера читается при старте из первой строки `nameserver` в `/etc/resolv.conf`. В Docker это `127.0.0.11`, в k8s — DNS кластера. Чарт передаёт полные имена сервисов (`<svc>.<ns>.svc.<clusterDomain>`, `clusterDomain` по умолчанию `cluster.local`), потому что резолвер nginx не применяет домены поиска.
- Правила nginx (блок `/internal`, CSP и заголовки, лимиты, страницы 413 и 502) не меняются и работают в обоих режимах.
- `X-Forwarded-For`: Ingress добавляет свой хоп. Доверие хопам в API задаётся переменной `TRUSTED_PROXY_HOPS` (сейчас константа 1): в compose остаётся 1, чарт по умолчанию ставит 2 (Ingress + web). Значение в values.

### 27.3 Секреты и настройки
- Секреты: `existingSecret` (имя готового Secret с ключами по таблице в README) или значения в `secrets.*` — тогда чарт создаёт Secret сам. Случайные значения чарт не генерирует (`lookup` ломается в Argo CD и `helm template`).
- Ключи: `APP_SECRET`, `ENCRYPTION_KEY`, `ONLYOFFICE_JWT_SECRET`, `ADMIN_LOGIN`, `ADMIN_PASSWORD`, `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `BACKUP_AGENT_TOKEN`, необязательные `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `LDAP_BIND_PASSWORD`. Пароли в URL не подставляются: API и агент принимают `DATABASE_PASSWORD` и `REDIS_PASSWORD` отдельно и сами вставляют их в `DATABASE_URL`/`REDIS_URL` с кодированием (`new URL()`), поэтому пароль внешней базы может содержать любые символы. `PGPASSWORD` в окружение API не попадает: `pg` подставил бы его в подключения к источникам данных без пароля. Агенту пароль базы передаётся как `PGPASSWORD` (источников данных у него нет).
- Настройки приложения из compose (`TZ`, `QUERY_TIMEOUT_MS`, `QUERY_MAX_ROWS`, `RENDER_TIMEOUT_MS`, `REPORT_TIMEOUT_MS`, `REPORT_RETENTION_DAYS`, `LDAP_*` кроме пароля, `BACKUP_CRON`, `BACKUP_KEEP`, `BACKUP_TIMEOUT`) — в values, в ConfigMap. Для каждого компонента: `resources`, `nodeSelector`, `tolerations`, `affinity`, `podAnnotations`, `extraEnv`.
- Изменение ConfigMap или Secret перезапускает поды: аннотация `checksum/config` и `checksum/secret` (для `existingSecret` — нет, это забота владельца секрета).
- Пробы:
  - api: readiness и liveness `GET /api/health`;
  - web: `GET /`;
  - агент: `GET /health`;
  - onlyoffice: `GET /healthcheck`, startupProbe до 5 минут;
  - postgres: `pg_isready`, redis: `redis-cli ping`, s3: `GET /healthz` (как в compose).

### 27.4 Несколько реплик API
- `migrateDb` и `migrateTemplateFiles` при старте выполняются под сессионной advisory-блокировкой Postgres на отдельном соединении (новый ключ `726100003`; `726100001` — бэкап и удаление файлов, `726100002` — сборка файлов запуска). Вторая реплика ждёт первую, затем видит, что миграции применены. В compose то же самое.
- Миграции должны быть совместимы с предыдущей версией приложения (добавляют, а не переименовывают и удаляют): при `helm upgrade` старые реплики несколько секунд работают на новой схеме. Правило — в README.
- Выкатка api: `maxUnavailable: 0`, `maxSurge: 1`.
- Хвосты Плана 14 в S3-клиенте API:
  - `maxAttempts: 2`, `requestTimeout` 30 с (общий срок вызова — до минуты, раньше до трёх);
  - `S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` необязательны: без них SDK берёт учётные данные из цепочки по умолчанию (IRSA, переменные окружения пода). Задан только один из двух ключей — ошибка конфигурации.
- Отдельная учётная запись S3 только на чтение для бэкапа снимается с повестки: восстановлению из админки нужна запись.

### 27.5 Бэкап и восстановление в k8s
- Агент: Deployment из одной реплики, `strategy: Recreate`, PVC RWO на `/backups` (`backup.persistence.size` по умолчанию 20Gi, `storageClass`). Расписание — внутри агента (`BACKUP_CRON`), не CronJob.
- Агент слушает `0.0.0.0:8080` (`BACKUP_AGENT_HOST` не задаётся). Service `<fullname>-backup-agent`; API получает `BACKUP_AGENT_URL=http://<fullname>-backup-agent:8080`.
- Восстановление из админки работает как в §26 без изменений протокола: все реплики API читают `cr:maintenance` из Redis, все подключаются с `application_name=api`, поэтому `pg_terminate_backend` закрывает сессии всех реплик; закрывать сессии своей роли Postgres разрешает без прав суперпользователя.
- Правки агента и скриптов (действуют и в compose):
  - фаза `redis` удаляет только ключи `cr:*`, кроме `cr:maintenance` (`SCAN MATCH cr:*`): общий внешний Redis не теряет чужие ключи. Все ключи приложения уже начинаются с `cr:`;
  - агент и скрипты принимают `PGHOST`, `PGPORT`, `PGUSER`, `PGDATABASE`, `PGSSLMODE`, `PGSSLROOTCERT`; пул агента передаёт SSL-параметры в `pg`. API — через `DATABASE_URL` с `sslmode` и `sslrootcert`;
  - без ключей S3 rclone работает с `env_auth=true` (IRSA).
- Аварийный путь — раздел README «Восстановление в Kubernetes без админки»: если API не поднимается, восстановление запускается прямо у агента тем же путём, что из админки (бэкап перед восстановлением, режим обслуживания, коды повтора):
  1. `kubectl port-forward svc/<fullname>-backup-agent 18080:8080`;
  2. токен — `BACKUP_AGENT_TOKEN` из Secret релиза;
  3. `curl` с `Authorization: Bearer`: `GET /backups`, `POST /backups/<имя>/restore`, ход — `GET /operation`, повтор по коду — `POST /recovery` (код — в `kubectl logs deploy/<fullname>-backup-agent`).
  Отдельного скрипта для k8s нет: `scripts/restore.sh` остаётся аварийным путём compose.
- README прямо говорит, что бэкапы лежат на томе в том же кластере, и советует снапшоты тома или Velero.

### 27.6 Безопасность и сеть
- api: `runAsNonRoot`, `readOnlyRootFilesystem` (emptyDir на `/tmp`), `allowPrivilegeEscalation: false`, `capabilities.drop: [ALL]`, `seccompProfile: RuntimeDefault` — совместимо с Pod Security «restricted».
- web, агент, OnlyOffice, Carbone и встроенные зависимости работают так же, как их образы (web, агент, OnlyOffice и Carbone — от root). Чарт в целом рассчитан на уровень «baseline»; README это говорит.
- `networkPolicy.enabled` (по умолчанию `false`) повторяет внутренние сети compose:
  - к агенту — только поды api;
  - к redis — api и агент; к s3 — api и агент; к postgres — api и агент;
  - к api — web и onlyoffice; к onlyoffice — web и api; к carbone — api;
  - выход наружу не ограничивается (внешние Postgres, Redis, S3, LDAP).
- ServiceAccount на релиз с `automountServiceAccountToken: false`; `serviceAccount.annotations` — для IRSA.

### 27.7 Образы и версии
- Все три образа приложения — `ghcr.io/samrozhkov/carbone-report-{api,web,backup}` с общим тегом `image.tag` (по умолчанию `appVersion` чарта). Агент несёт миграции из того же коммита, поэтому разные версии api и агента не допускаются: отдельного тега для агента нет.
- `image.registry`, `image.pullPolicy`, `imagePullSecrets` (пакеты GHCR приватные, пока их не сделали публичными).
- Образы Carbone, OnlyOffice и зависимостей — те же версии, что в compose, переопределяются в values.

### 27.8 Публикация
- Чарт — в `charts/carbone-reports`, `version` и `appVersion` в `Chart.yaml`.
- На тег `vX.Y.Z` задание CI упаковывает чарт с `--version X.Y.Z --app-version X.Y.Z` и публикует `oci://ghcr.io/samrozhkov/charts/carbone-reports`. На `main` и PR — только проверки.
- README: раздел «Kubernetes (Helm)» — установка из OCI и из каталога, минимальные values для внешних зависимостей и для пробной установки со встроенными, таблица ключей Secret, Ingress, обновление, бэкапы.

### 27.9 Проверка
- **CI, задание `chart`** (после `checks`):
  - `helm lint` с наборами values `ci/*.yaml`: встроенные зависимости; всё внешнее с `existingSecret`; NetworkPolicy и выключенные Carbone/OnlyOffice;
  - helm-unittest: секреты (`existingSecret` против `secrets.*`), флаги встроенных зависимостей и адреса в env, ошибки при пропущенных обязательных значениях, NetworkPolicy, `TRUSTED_PROXY_HOPS`, `securityContext` api, совпадение скрипта SeaweedFS;
  - `kubeconform -strict` для каждого набора `ci/*.yaml`.
- **CI, задание `chart-kind`** (после `chart` и `integration`):
  - образы api, web и backup собираются из текущего коммита и загружаются в kind;
  - установка со встроенными postgres, redis и s3, Carbone и OnlyOffice выключены (`carbone.url`/`onlyoffice.internalUrl` указывают на несуществующий адрес: smoke отчёты не формирует), `helm install --wait`;
  - smoke через `kubectl port-forward` к web: `/api/health`, вход администратора, страница отдаётся с CSP; бэкап через API (`POST /api/admin/backups`, ожидание `succeeded`), изменение данных, восстановление, ожидание снятия `cr:maintenance`, данные из бэкапа на месте; две реплики api после восстановления отвечают;
  - при провале — `kubectl get events`, описания подов и журналы в выводе задания.
- **Модульные и интеграционные тесты** правок приложения: advisory-блокировка старта (два параллельных старта — миграции один раз), S3 без ключей, `TRUSTED_PROXY_HOPS`, `flushExcept` по `cr:*`, SSL-параметры агента, шаблон nginx в обоих режимах (compose-тест образа web).
- **Вручную:** полный прогон в kind или в кластере с Carbone и OnlyOffice — открыть шаблон в редакторе, сформировать отчёт, бэкап и восстановление из админки.

## 28. План 17: своя сборка Carbone внутри API (версия 2.0.0)

Цель — отказаться от образа `carbone/carbone-ee` и LibreOffice. Отчёты собирает своя сборка Carbone, встроенная в API библиотекой. Перевод в другой формат (PDF, ODT, ODS, DOCX из ODT…) делает OnlyOffice Document Server, который уже входит в стек. Исследование различий открытой и коммерческой версий — `docs/superpowers/notes/2026-10-09-carbone-ce-vs-ee.md`.

Работа идёт в ветке `feat/carbone-embedded`. Результат — версия 2.0.0. Когда слить в `main`, поставить тег `v2.0.0` и опубликовать, решает владелец проекта; исполнитель плана этого не делает.

Критерий готовности:
- все примеры «Справки по шаблонам» проходят `pnpm help:check` без правки текста справки, включая раздел «Недоступно» с прежним текстом ошибки;
- пробы матрицы Community и примеры справки дают тот же результат, что `carbone-ee:full-5.15.3-fonts` без лицензии (эталоны в 28.4); каждое расхождение исправлено или записано в эталон как осознанное, с объяснением;
- шаблоны пользователей в S3 не меняются;
- в compose и чарте нет контейнера Carbone и LibreOffice.

Не входит в план:
- платные функции EE: графики, изображения из данных, HTML, штрихкоды, цвета, агрегаторы, `drop/keep`, операции с PDF — следующие планы;
- переключатель на старый рендер через Carbone EE;
- изменение порядка сборки отчёта: API по-прежнему сначала собирает PDF, поэтому без OnlyOffice отчёт не строится.

### 28.1 Пакет `packages/carbone`
- Код форка `SamRozhkov/carbone` (Carbone Community 3.8.2, Carbone Community License) переносится в монорепо через `git subtree` вместе с историей. Лицензия пакета — CCL, файл `LICENSE.md` сохраняется; `NOTICE.md` описывает происхождение кода, отличия от апстрима и правило чистой реализации.
- Правило чистой реализации: новые возможности пишутся по открытой документации carbone.io и наблюдаемому поведению EE (эталоны 28.4). Код из образа `carbone-ee` не читается и не копируется — он закрытый и CCL не покрыт.
- Изменённый пакет не публикуется отдельно (npm, отдельный образ): CCL разрешает распространять изменённый Carbone только в составе продукта (2.1(b), 2.1(d)). В `package.json` пакета — `"private": true`.
- Публичная функция `renderBuffer(template: Buffer, ext, data, { lang, timezone }): Promise<Buffer>` — отчёт в формате шаблона, без временных файлов. Код конвертации LibreOffice (`converter.js`, `converter.py`, `soffice`) удаляется вместе с опцией `convertTo`.
- Переносится синтаксис бесплатного режима Carbone v4/v5, на который опираются справка и матрица:
  - итератор `.i` (`{d.rows[i].x:print(.i)}`, `[.i+1]`), циклы по массиву строк `{d.tags[i]}`;
  - `:set` с записью в `c.` и группировка `c.g[id=.key].rows[]`;
  - форматтеры, которых нет в 3.8.2 и которые в EE 5.15.3 без лицензии работают: `ellipsis, append, replace, mod, abs, ceil, floor, formatI, diffD, ifTE` и остальные из матрицы — полный список фиксирует план по эталонам.
- Поведение бесплатного режима EE 5.15.3:
  - `aggSum, aggAvg, aggMin, aggMax, aggCount, aggCountD, aggStr, aggStrD, cumSum, cumCount, cumCountD, drop, keep, html, color, barcode, chart, formatR, defaultURL, autoOrient` дают ошибку `Formatter "X" is disabled in the Community Edition.` (с точкой), за ней ` Source: "<тег>"` — как в EE; `count()` даёт ту же ошибку с именем `cumCount`;
  - даты не зависят от часового пояса процесса: дата без пояса разбирается как UTC и выводится в `timezone` из опций — как в EE (пример справки `fmt-date-naive`);
  - прочие отличия 3.8.2 от EE, которые ловят пробы матрицы: повтор с `[i]` и `[i+1]` в одном абзаце (в 3.8.2 вставляет весь документ), `ifEmpty` не обрывает цепочку, литерал `'.'` в аргументах, `substr` по словам, сдвиг и количество в `arrayJoin`, целевая валюта `formatC`, теги `{o.…}`, ошибка цикла без `[i+1]`; `:set` с суммированием повторяет особенность EE (пример `totals-set-sum`).

### 28.2 Рендер в API (`apps/api/src/modules/render/`)
Новая реализация интерфейса `CarboneRenderer.render(tpl, data, { convertTo, lang, timezone, timeoutMs })`; `reports/service.ts` не меняется.

- `pool.ts` — пул `worker_threads`, размер `RENDER_WORKERS` (по умолчанию `min(4, число ядер)`). Задача, не уложившаяся в `timeoutMs`, останавливает свой поток (`worker.terminate()`), поток пересоздаётся. Очередь пула учитывает срок: задача, у которой срок истёк в очереди, не запускается.
- `worker.ts` — получает буфер шаблона, расширение и данные, вызывает `renderBuffer`, возвращает буфер (передача без копирования через `transferList`).
- `handoff.ts` — файлы для OnlyOffice в памяти реплики: `put(buf, ttlMs) → id`, разовая выдача, удаление по сроку. Маршрут `GET /internal/render-files/:id?t=<JWT>`: проверяет токен (HS256 на `APP_SECRET`, `aud: render-file`, `sub: id`, срок не больше срока рендера), отдаёт файл один раз и удаляет его. Снаружи `/internal/*` закрыт в nginx.
- `onlyoffice-convert.ts` — `POST {ONLYOFFICE_INTERNAL_URL}/converter`, тело `{ async: false, filetype, outputtype, key, title, url, token }`, `token` — JWT тела на `ONLYOFFICE_JWT_SECRET`. `key` — случайный на каждый вызов (Document Server кэширует результат по ключу). `fileUrl` ответа переводится во внутренний адрес `toInternalDownloadUrl` (модуль onlyoffice), результат скачивается. Запрос прерывается по сроку рендера.
- `renderer.ts` — чтение шаблона → пул → если `convertTo` равен расширению шаблона, результат сразу; иначе `handoff.put` и конвертация. Допустимые пары — `outputFormatsFor` из `shared`.
- Адрес ссылки для Document Server — `API_SELF_URL` (адрес именно этой реплики): в compose `http://api:3000`, в чарте `http://$(POD_IP):3000` через downward API.

Ошибки (коды и тексты для пользователя прежние, см. раздел об ошибках):

| Ситуация | HTTP | Код |
|---|---|---|
| Ошибка шаблона (синтаксис, неизвестный форматтер) | 502 | `CARBONE_ERROR`, `ошибка генерации: <текст Carbone>` — как раньше |
| Форматтер отключён в бесплатной версии | 400 | `CARBONE_COMMUNITY` (`community.ts` без изменений) |
| Срок рендера истёк (в очереди, в потоке или в конвертации) | 504 | `TIMEOUT` |
| Поток упал | 502 | `CARBONE_ERROR`, поток пересоздаётся, запись в журнал |
| OnlyOffice недоступен | 502 | `CONVERT_ERROR`, `сервис конвертации недоступен` |
| OnlyOffice вернул `error: -N` | 502 | `CONVERT_ERROR`, `ошибка конвертации (код N)` |

Сборка отчёта в формате шаблона OnlyOffice не требует, но API строит отчёт сначала в PDF (и предпросмотр — PDF), поэтому на практике без OnlyOffice отчёты не строятся.

Удаляются: `modules/carbone/client.ts`, `template-cache.ts` и их тесты, кэш идентификаторов шаблонов в Redis, `CARBONE_URL`. Остаётся `modules/carbone/community.ts`.

### 28.3 Развёртывание
- Compose: сервисы `carbone` и том `carbone_templates` удаляются; у `api` — `API_SELF_URL: http://api:3000`.
- Чарт: компонент `carbone` удаляется целиком (шаблон, `carbone.*` в values, проверки, NetworkPolicy, тесты, `ci/*.yaml`). У api — env `POD_IP` из `status.podIP` и `API_SELF_URL`; NetworkPolicy api уже пускает onlyoffice. Ресурсы api по умолчанию: `requests: { cpu: 500m, memory: 512Mi }`, `limits: { memory: 2Gi }` (сборка отчётов теперь в api; план уточняет по замеру на матрице и фиксирует в values).
- Новые настройки API: `RENDER_WORKERS` (1–16, по умолчанию `min(4, ядра)`), `API_SELF_URL` (по умолчанию `http://api:3000`).
- README, раздел «Обновление с 1.x»: старый контейнер и том Carbone больше не нужны (`docker compose up --remove-orphans`, том удаляется вручную); `CARBONE_URL` не читается; ключи `cr:carbone:*` в Redis не используются (команда удаления приводится); шаблоны в S3 не меняются; PDF собирает OnlyOffice — вёрстка ближе к редактору и может немного отличаться от отчётов 1.x.

### 28.4 Проверка
- Эталоны `packages/carbone/test/golden/*.json` строятся из уже записанных ответов `carbone-ee:full-5.15.3-fonts` без лицензии: 248 проб матрицы Community (`docs/superpowers/notes/2026-10-13-carbone-community-matrix.md`, набор проб переносится в репозиторий) и 44 примера справки с ожидаемым результатом из `content.ts`. Скрипт разработки `scripts/carbone-parity.ts` дописывает эталоны для новых проб, поднимая образ EE; в CI образ EE не нужен.
- `packages/carbone`: тесты апстрима без тестов конвертации, тесты новых возможностей, сверка с эталонами — в задаче проверок CI.
- API, модульные: пул (таймаут останавливает поток, упавший поток пересоздаётся, очередь соблюдает срок), handoff (токен, одноразовость, срок), клиент конвертации (тело, JWT, коды ошибок), рендерер (формат шаблона — без OnlyOffice).
- API, интеграционный тест с настоящим Document Server: docx → pdf, xlsx → ods, odt → docx; результат — корректный файл с подставленным текстом. В CI всегда; локально — по флагу (образ 3,4 ГБ).
- `pnpm help:check` рендерит через пакет напрямую, без поднятого стека.
- Kind-смоук включает OnlyOffice (`onlyoffice.enabled=true`) и строит отчёт в PDF и docx: это проверка передачи файла Document Server по адресу пода (`API_SELF_URL`) в кластере.

## 29. 2.0.1: доработки после 2.0.0

Отложенное финальным ревью Плана 17 (`notes/2026-10-02-backend-follow-ups.md`, «Итоги Плана 17»). Интерфейсы API и формат отчётов не меняются.

### 29.1 Дренаж при остановке
- Рендерер считает активные отчёты (сборка и конвертация) и даёт `idle(): Promise<void>` — выполняется, когда активных нет.
- По SIGTERM/SIGINT API: (1) ставит флаг остановки — `GET /api/ready` отвечает 503 `{ status: 'draining' }`, `GET /api/health` по-прежнему 200; (2) продолжает обслуживать запросы, в том числе `/internal/render-files` для Document Server; (3) ждёт `idle()` рендерера и завершения всех HTTP-запросов, кроме проб и `/internal/render-files` (отчёт на этапе SQL рендер ещё не начал), не дольше `max(RENDER_TIMEOUT_MS, REPORT_TIMEOUT_MS) + 5 с`; (4) затем закрывает Fastify, пулы и потоки, как сейчас. Новые отчёты во время дренажа принимаются (балансировщик снимает под по readiness; принятый отчёт укладывается в тот же срок).
- `GET /api/ready` — 200 `{ status: 'ok' }`, доступен в режиме обслуживания. Чарт: `readinessProbe` → `/api/ready`; `startupProbe` и `livenessProbe` остаются на `/api/health`. `terminationGracePeriodSeconds` у api = `ceil(max(renderTimeoutMs, reportTimeoutMs) / 1000) + 30`; в compose у api `stop_grace_period: 130s` и `depends_on: onlyoffice` (Document Server останавливается после api).
- Журнал: начало дренажа (число активных отчётов) и итог (дождались / истёк срок).

### 29.2 Режим обслуживания
`GET /internal/render-files/:id` и `GET /api/ready` в белом списке режима обслуживания: отчёт, начатый до включения режима, доконвертируется. Доступ к файлу и так закрыт разовым токеном.

### 29.3 Срок готовности потока
Поток рендера, не приславший `{ ready: true }` за `readyTimeoutMs` (по умолчанию 30 с, опция пула), останавливается и пересоздаётся с той же нарастающей паузой, что и упавший до готовности; `onCrash(err, { hadTask: false, beforeReady: true })`.

### 29.4 `hideBegin` в конце предыдущей строки
Отличие `matrix/tests2/hide-row-hidebegin-at-end-of-prev-row-hideend-at-end-of-row` устраняется, если это удаётся без регрессий остальных эталонов и тестов апстрима: метки в строке-разделителе `[i+1]` не участвуют в разборе (как в EE). Если исправление требует перестройки разбора зоны `[i+1]` с риском регрессий — отличие остаётся, решение записывается в заметку.

### 29.5 Не входит
Проба `null`/объектов в массиве строк против EE: нужен образ EE (3,7 ГБ), локально места нет — остаётся владельцу (`scripts/carbone-parity.ts`). Платные функции EE.

### 29.6 Выпуск
Слияние в `main` после зелёного CI ветки, тег `v2.0.1` после зелёного CI `main`.

## 30. 2.1.0: версия сборки, CHANGELOG, лицензия

Решения владельца (2026-10-10): версия — только в интерфейсе (CHANGELOG в репозитории и в описании выпуска на GitHub, в интерфейсе его нет); лицензия — PolyForm Strict 1.0.0. Платные функции EE — следующие выпуски (§30.5).

### 30.1 Версия сборки
- Три значения: `version` — тег выпуска без `v` (`2.1.0`), для остальных сборок `dev`; `commit` — короткий SHA (7 символов) или `unknown`; `builtAt` — дата коммита в ISO 8601 или `unknown`.
- Образы api, web и backup получают их через `ARG APP_VERSION=dev`, `ARG APP_COMMIT=unknown`, `ARG APP_BUILD_DATE=unknown`. CI передаёт `build-args`: для тега — версия из тега, иначе `dev`; `APP_COMMIT` — первые 7 символов `github.sha`; `APP_BUILD_DATE` — `git log -1 --format=%cI`. Compose передаёт те же аргументы из переменных окружения с теми же значениями по умолчанию.
- API: значения из переменных окружения `APP_VERSION`/`APP_COMMIT`/`APP_BUILD_DATE` (в прод-стадии образа — `ENV` из `ARG`); при запуске журнал пишет их одной строкой. `GET /api/version` → 200 `{ version, commit, builtAt }`, только для вошедших (любая роль), иначе 401 как у остальных маршрутов.
- Backup-агент: те же `ENV`; строка версии в журнале при запуске.
- Web: значения встраиваются при сборке Vite (`define`: `__APP_VERSION__`, `__APP_COMMIT__`, `__APP_BUILD_DATE__` из `process.env.APP_VERSION` и т. п., по умолчанию `dev`/`unknown`).
- Интерфейс: в подвале боковой панели пункт «Версия X» (иконка `CircleInfo`; в свёрнутом виде — только иконка с подсказкой). Щелчок открывает окно «О программе»: версия, коммит и дата сборки интерфейса; версия и коммит сервера (из `/api/version`); строка «Лицензия: PolyForm Strict 1.0.0». Если версия или коммит интерфейса и сервера различаются — предупреждение «Версии интерфейса и сервера различаются — обновите страницу или проверьте развёртывание». Ошибка запроса — «Версия сервера недоступна», окно остаётся рабочим.

### 30.2 CHANGELOG
- `CHANGELOG.md` в корне, формат Keep a Changelog на русском: разделы `## [2.1.0] — 2026-10-10`, `## [2.0.2] — …`, `## [2.0.1]`, `## [2.0.0]`, `## [1.0.0]`, внутри — «Добавлено», «Изменено», «Исправлено», «Удалено» (только непустые). Для 2.0.0 и раньше — выжимка из заметки follow-ups и README «Обновление с 1.x» (главное для администратора: несовместимые изменения и шаги обновления). Внизу ссылки сравнения тегов на GitHub.
- `scripts/changelog-section.mjs <версия>` печатает текст раздела этой версии (без заголовка); нет раздела или он пуст — код выхода 1 и сообщение.
- CI: в задании проверок на теге — проверка, что раздел есть (выпуск без записи в CHANGELOG не публикуется). Новое задание «Выпуск на GitHub» на теге после публикации чарта: `gh release create <тег> --title <тег> --notes-file <раздел>`; права `contents: write` только у этого задания.

### 30.3 Лицензия
- `LICENSE.md` в корне — текст PolyForm Strict License 1.0.0 дословно (источник — polyformproject.org), строка `Required Notice: Copyright 2026 Sam Rozhkov (https://github.com/SamRozhkov)`.
- `NOTICE.md` в корне: лицензия проекта; `packages/carbone` — производная работа Carbone Community Edition под CCL (`packages/carbone/LICENSE.md`), на него лицензия проекта не распространяется; сторонние зависимости — под своими лицензиями; Document Server — отдельный продукт под своей лицензией.
- `license` в `package.json` корня, `apps/*`, `packages/shared`: `SEE LICENSE IN LICENSE.md` (для пакетов — путь к корневому файлу не обязателен, достаточно поля). Чарт: аннотация не нужна; `charts/carbone-reports/LICENSE` не добавляется.
- Образы api, web, backup: `LICENSE.md` и `NOTICE.md` копируются в образ (`/app` для api, `/agent` для backup, `/usr/share/doc/carbone-reports/` для web); в образ api дополнительно попадает `packages/carbone/LICENSE.md` (если `pnpm deploy` его уже кладёт — проверить и не дублировать). Метка OCI `org.opencontainers.image.licenses` = `PolyForm-Strict-1.0.0` (через `labels` metadata-action).
- README: раздел «Лицензия» — коротко на русском, что разрешено (некоммерческое использование без изменений), что нет (изменения, распространение, коммерческое использование — по отдельному договору), и про CCL у `packages/carbone`.

### 30.4 Выпуск
Ветка `feat/2.1.0`; слияние в `main` и тег `v2.1.0` — с отдельного разрешения владельца.

### 30.5 Дальше: платные функции EE
Согласовано владельцем 2026-10-10, все четыре группы, отдельными выпусками в таком порядке: 2.2.0 — агрегаторы (в том числе `:count()`/`cumCount` — сплошная нумерация строк цикла 1…N и при фильтре; пример «Номер строки» в справке обновляется; `print(.i):add(1)` остаётся рабочим), `drop`/`keep`, сортировка по убыванию; 2.3.0 — изображения из данных (base64 и URL из белого списка), штрихкоды (`bwip-js`), `color`/`bindColor`, `defaultURL`; 2.4.0 — `:html` и графики (ECharts → изображение); 2.5.0 — PDF/A, водяной знак, склейка PDF (`pdf-lib`), пароль на PDF отложен. Эталона EE для платных функций нет (без лицензии EE их отключает, код образа не читается): поведение — по открытой документации Carbone, тесты свои. Каждая группа — свой раздел спецификации и план.

## 31. 2.2.0: агрегаторы и `drop`/`keep`

Первая группа платных функций EE (§30.5). Справочник поведения — `notes/2026-10-10-ee-aggregators-drop-sort.md` (открытая документация carbone.io; эталона EE нет). Где документация молчит, решение записано здесь и считается нашим поведением; тесты — свои, в `packages/carbone/test/test.ee-paid.js`.

### 31.1 Агрегаторы
- Функции: `aggSum`, `aggAvg`, `aggMin`, `aggMax`, `aggCount`, `aggCountD`, `aggStr`, `aggStrD`, `cumSum`, `cumCount`, `cumCountD`; `:count()` — то же, что `cumCount` (сплошная нумерация 1…N, в том числе в цикле с фильтром). Убираются из `DISABLED` в `lib/community.js`.
- Синтаксис и примеры — как в справочнике §1: вне цикла по `[]` (`{d.cars[].qty:aggSum}`), с фильтром (`{d.cars[sort>1].qty:aggSum}`), внутри цикла `[i]` (итог по всему набору на каждой строке), по вложенному массиву (`{d[i].cities[].cars:aggSum}` — подытог на элемент внешнего цикла), цепочка `:aggSum:cumSum`. Необязательный аргумент partition-by — путь с точкой (`aggSum(.brand)`); у `aggStr`/`aggStrD` первый аргумент — разделитель (по умолчанию `', '`), второй — partition-by.
- Форматтеры до агрегатора применяются к каждому значению (`:mul(.sort):aggSum`); после — к результату (`:aggSum:formatN(2)`).
- Наши решения (документация молчит): числовые агрегаторы (`aggSum/Avg/Min/Max`, `cumSum`) берут значения, для которых `Number(v)` конечно, кроме `null`, `undefined` и `''`; остальные пропускают. Пустой набор: `aggSum`, `cumSum`, `aggCount`, `aggCountD` → `0`; `aggAvg`, `aggMin`, `aggMax`, `aggStr`, `aggStrD` → пустая строка. `aggCount`/`cumCount` считают элементы независимо от значения; `aggCountD`/`cumCountD`/`aggStrD` сравнивают значения строго (`===`); объекты и массивы в качестве значений пропускаются. `aggStr` пропускает `null`/`undefined`/`''`. Значение под-объекта (`{d[].sub.qty:aggSum}`) — ошибка, как в документации (обход `print(.sub.qty)`).
- Справка: агрегаторы переезжают из «Недоступно» в новый раздел «Итоги и нумерация» (примеры проверяются `pnpm help:check`); пример «Номер строки» показывает `:count()` и оставляет `print(.i):add(1)`.
- Решения реализации (2.2.0, документация молчит):
  - Режим по скобкам: `[]`/`[фильтр]` — набор (итог на строку вывода: вне цикла — одна, `{d[i].cities[].cars}` — на элемент внешнего цикла); только `[i]`-циклы — строки цикла, `agg*` — по всему набору всех уровней (или partition), `cum*` — в порядке вывода, сквозь вложенные уровни (сброс по родителю — `cumSum(..поле)`). Путь без скобок — набор из одного значения.
  - Циклы по ключу (`[brand]`, `[q]`): `agg*` первого шага — по всем элементам; `cum*`, `count()` и следующие шаги цепочки — по выведенным строкам (1…N без пропусков). Порядок `cum*` — по скобкам самой метки-агрегатора (сортировку цикла нужно повторить в ней).
  - Ошибки шаблона: `cum*`/`count()` по `[]`; partition-by у первого агрегатора по `[]`; аргумент partition-by без точки; агрегаторы в цепочке не подряд; `show`/`elseShow`/`showBegin`/`hideBegin`/`ifEqual`/`ifContain` и т. п. до агрегатора (подсказка — фильтр в скобках); значение во вложенном объекте под `[]`. Внутри `[i]` вложенный путь (`d[i].sub.qty`) допустим.
  - Числа: строки — только десятичная запись (с экспонентой); строки из пробелов и `0x…` — не числа; `true` считается как 1 (`Number(true)`).
  - `aggCountD`/`cumCountD`/`aggStrD`/`aggStr` пропускают `null`, `undefined`, `''`, объекты и массивы.
  - `aggStrD` — порядок по последнему вхождению (по примеру документации: Lexus, Faraday, Venturi, Faraday, Aptera, Venturi → Lexus, Faraday, Aptera, Venturi).
  - `cumCountD` — по определению (1, 2, 3, 3, 4, 4 для тех же данных; пересказ документации с 1, 2, 2, … противоречит своим данным).
  - `count(N)`: аргумент начала отсчёта формата 3.8.2 отбрасывается, нумерация с 1.
  - Внешний цикл по ключу + `[]` (`{d.cars[brand].items[].q:aggSum}`) — подытог только выведенного (первого) элемента группы, как и строки CE; группировку делать через `:set` или SQL.

### 31.2 `drop` / `keep`
- `:drop(эл[, N])` удаляет элемент, если значение слева истинно (результат `ifXX` или булево/непустое значение по правилам `ifXX`); `:keep(эл[, N])` — удаляет, если ложно. Тег сам ничего не печатает.
- Элементы и форматы (как в справочнике §2): `p`, `row` (с N — текущий и N−1 следующих), `table`, `img`, `shape`, `chart`, `col` (по одному `drop(col)` на столбец, объединённые ячейки не поддерживаются) — DOCX, ODT, PPTX, ODP (где элемент есть); `row`, `col` — XLSX, ODS; `img`, `sheet` — ODS; `slide`, `item` — ODP; `item`, `h` — ODT. Неподдержанное сочетание элемента и формата — ошибка шаблона `drop(<эл>) не поддерживается в <формат>` (400 как прочие ошибки шаблона), а не молчаливое игнорирование.
- Для `img`, `shape`, `chart` тег ставится в заголовок/замещающий текст объекта.
- Удалены все строки таблицы (Review Focus 4): таблица без строк невалидна, поэтому в DOCX/ODT/PPTX/ODP она удаляется целиком (в PPTX — с `p:graphicFrame`, в ODP — с `draw:frame`), так же при удалении всех столбцов `drop(col)`; строка заголовка, на которой нет `drop`, остаётся, и таблица с ней сохраняется. Лист ODS не удаляется — в нём остаётся одна пустая строка; в XLSX пустой `sheetData` допустим. Ячейка DOCX (и надпись `w:txbxContent`), из которой удалены все абзацы или последний абзац после вложенной таблицы, получает пустой `<w:p/>`; текст фигуры PPTX без абзацев — пустой `<a:p/>`. `drop(sheet)` всех листов ODS и `drop(slide)` всех слайдов ODP — ошибка шаблона.
- Решения реализации (2.2.0, документация молчит):
  - Условие без `ifXX` — само значение: булево как есть, прочее истинно, если не пусто по правилам `ifNEM` (`0` и `'false'` — истинны; `null`, `''`, `[]`, `{}`, отсутствующий ключ — ложны).
  - `drop`/`keep` — последний форматтер метки; второй аргумент — целое от 1 и только у `p`/`row`; `N` считает текущий элемент и берёт следующие элементы того же типа у того же родителя (другие элементы между ними пропускаются и остаются); элементов меньше — удаляется сколько есть.
  - Сочетание элемента и формата проверяется до сборки, независимо от условия и данных. Если вокруг метки нет нужного элемента (`drop(row)` вне таблицы, `drop(img)` не в картинке) — ошибка `Для drop(<эл>) метка должна стоять …` с меткой в `Source`, также независимо от условия (по каждой выведенной метке). HTML, XML, TXT и прочие форматы — `drop(<эл>) не поддерживается в <формат>`.
  - DOCX: `img`/`shape`/`chart` — ближайший `w:drawing` с картинкой (`pic:pic`) / фигурой (`wps:wsp`, `wpg:wgp`, `wpc:wpc`) / диаграммой (`c:chart`); если он в `mc:AlternateContent`, удаляется весь блок вместе с запасным VML. PPTX: `img` — `p:pic`, `shape` — `p:sp`/`p:cxnSp`/`p:grpSp`, `chart` и `table` — `p:graphicFrame`. ODF: `img` и `chart` — `draw:frame` с `draw:image` / `draw:object`, `shape` — фигуры `draw:*` и текстовый фрейм.
  - `drop(col)`: номер столбца — по позиции ячейки в строке (в ODF с учётом `number-columns-repeated`, повтор уменьшается); удаляются ячейки во всех строках таблицы и описание столбца (`w:gridCol`, `a:gridCol`, `table:table-column`, в XLSX — сдвиг диапазонов `<col min max>`). Объединение по горизонтали (`gridSpan`, `hMerge`, `gridBefore/After`, `number-columns-spanned`) — ошибка шаблона. В XLSX объединения ячеек, `dimension`, автофильтр и условное форматирование не пересчитываются.
  - Ограничения: абзац DOCX с разрывом раздела (`w:sectPr` в `w:pPr`) удаляется вместе с разрывом; во встроенных в DOCX таблицах диаграмм и в имени отчёта `drop` не поддерживается.
- Справка: раздел «Условия» получает примеры `drop(row)`, `drop(p)`, `keep(p)`; из «Недоступно» убираются.

### 31.3 Не входит
- Сортировка по убыванию: в Carbone её нет (документация — «скоро в v5»), синтаксис не опубликован; своё расширение может разойтись с будущим синтаксисом Carbone. Остаётся SQL `ORDER BY … DESC` (пример в справке сохраняется). Решение контроллера 2026-10-10, владелец уведомляется.
- `drop(div|span)` (вывод HTML не поддерживается продуктом).

### 31.4 Выпуск
Ветка `feat/2.2.0` (от `feat/2.1.0`); запись в CHANGELOG; слияние и тег `v2.2.0` — с разрешения владельца.
