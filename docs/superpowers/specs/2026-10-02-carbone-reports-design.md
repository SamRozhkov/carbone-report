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
3. `CarboneClient.render(file, data, { convertTo: format, lang: "ru-ru", timezone: TZ })`:
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
- Отклонённый токен получает 403 и `{"error":1}`. Document Server повторит callback со свежим токеном.
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
