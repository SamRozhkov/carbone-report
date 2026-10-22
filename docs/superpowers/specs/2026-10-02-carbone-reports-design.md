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
    "coEditing": { "mode": "fast", "change": false },
    "customization": { "forcesave": true },
  },
}
```

На фронте используется `<DocumentEditor>` из `@onlyoffice/document-editor-react`, `documentServerUrl = /onlyoffice/`.

### 5.2 Сохранение

- Кнопка «Сохранить» в UI вызывает `POST /api/templates/:id/save`. `api` отправляет `{"c":"forcesave","key":doc_key}` (с JWT) в Command Service Document Server.
- Редактор всегда в быстром режиме совместного редактирования без переключателя (`coEditing`): в строгом режиме правки не уходят на Document Server до кнопки сохранения в самом редакторе, и forcesave отвечает «изменений нет». Ответ Command Service `error 4` (изменений нет) — `409 NO_CHANGES` «нет несохранённых изменений»: callback не придёт, UI сообщает об этом сразу.
- `POST /internal/onlyoffice/callback/:id`:
  - JWT проверяется из `Authorization` или поля `token` тела. Если подпись неверна — `403`;
  - `status 2` (документ закрыт всеми) и `status 6` (forcesave): файл скачивается по `url`, записывается атомарно, `version++`, обновляются `updated_at` и `updated_by` (по `users[0]`);
  - только при `status 2` дополнительно генерируется новый `doc_key`. Во время активной сессии ключ не меняется;
  - `status 3`/`7` (ошибка сохранения): запись в лог, событие доступно фронту через `GET /api/templates/:id` (`lastSaveError`);
  - остальные статусы: только подтверждение; статус каждого callback пишется в журнал API, callback прежней сессии (другой `doc_key`) со статусом сохранения — с предупреждением;
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
- **Форма отчёта.** SQL-параметр отображается как `Select` с поиском, при `multiple` — с множественным выбором; над поиском — флажок «Выбрать все» (весь список вариантов без учёта поиска; когда выбраны все — «Снять все», при частичном выборе — промежуточное состояние).
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
Согласовано владельцем 2026-10-10, все четыре группы, отдельными выпусками в таком порядке: 2.2.0 — агрегаторы (в том числе `:count()`/`cumCount` — сплошная нумерация строк цикла 1…N и при фильтре; пример «Номер строки» в справке обновляется; `print(.i):add(1)` остаётся рабочим), `drop`/`keep`, сортировка по убыванию; 2.3.0 — изображения из данных (base64 и URL из белого списка), штрихкоды (`bwip-js`), `color`/`bindColor`, `defaultURL`; 2.4.0 — `:html` и графики (ECharts → изображение); 2.5.0 — PDF/A, водяной знак, склейка PDF (`pdf-lib`), пароль на PDF отложен. **Сдвиг 2026-10-10 (решение владельца):** 2.3.0 — перенос шаблонов между средами (§33); изображения/штрихкоды/цвета — 2.4.0 (§32), HTML и графики — 2.5.0, PDF — 2.6.0. **Сдвиг 2026-10-11 (решение владельца):** 2.5.0 — нативные диаграммы DOCX/XLSX и `:html` в полном объёме документации (§34); графики ECharts (`:chart`) — отдельным выпуском после 2.5.0, PDF — за ним. **Очередь 2026-10-14 (решение владельца), по порядку:** 2.6.0 — графики ECharts (`:chart`); 2.7.0 — PDF; 2.8.0 — редактор шаблона: документ одновременно редактирует один сотрудник, остальным он открывается только для просмотра (с указанием, кто редактирует); режим «на весь экран» с панелью тегов справа; вставка тегов копированием остаётся, перетаскивание в документ — если подтвердит проверка на OnlyOffice. **Уточнение 2026-10-15 (решение владельца):** PDF делится на три выпуска по очереди — 2.7.0 — PDF/A, водяной знак, нумерация, метаданные, приложенные PDF-файлы шаблона (§36); 2.7.1 — пароль и ограничения; 2.7.2 — электронная подпись; редактор шаблона — после них. **Сдвиг 2026-10-15 (решение владельца):** электронная подпись — в самом конце очереди, после редактора шаблона 2.8.0 (§38). Эталона EE для платных функций нет (без лицензии EE их отключает, код образа не читается): поведение — по открытой документации Carbone, тесты свои. Каждая группа — свой раздел спецификации и план.

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
- Удалены все строки таблицы (Review Focus 4): таблица без строк невалидна, поэтому в DOCX/ODT/PPTX/ODP она удаляется целиком (в PPTX — с `p:graphicFrame`, в ODP — с `draw:frame`), так же при удалении всех столбцов `drop(col)`; строка заголовка, на которой нет `drop`, остаётся, и таблица с ней сохраняется. Лист ODS не удаляется — в нём остаётся одна пустая строка; в XLSX пустой `sheetData` допустим. Ячейка DOCX (а также надпись `w:txbxContent`, колонтитул, сноска, примечание), из которой удалены все абзацы или последний абзац после вложенной таблицы, получает пустой `<w:p/>` (блок `w:sdtContent` — если в нём не осталось ни одного блока); группа строк или столбцов ODF (`table:table-header-rows`, `table:table-row-group` и т. п.) без элементов удаляется; текст фигуры PPTX без абзацев — пустой `<a:p/>`. `drop(sheet)` всех листов ODS и `drop(slide)` всех слайдов ODP — ошибка шаблона.
- Решения реализации (2.2.0, документация молчит):
  - Условие без `ifXX` — само значение (решение контроллера 2026-10-10, чтобы флаги 0/1 и `'false'` из БД работали как ожидается): истинны `true`, ненулевое число, строка кроме `''`, `'0'`, `'false'` (сравнение после обрезки пробелов, `false` — без учёта регистра), непустой массив или объект; ложны `false`, `0`, `NaN`, `''`, `'0'`, `'false'`, `null`, отсутствующий ключ, `[]`, `{}`.
  - `drop`/`keep` — последний форматтер метки; `show`, `elseShow`, `showBegin`/`hideBegin`, `ifEqual`, `ifContain` перед ним — ошибка шаблона (они останавливают цепочку, и `drop` молча не сработал бы); жетон метки содержит случайный ключ сборки — значение из данных отчёта не может его подделать; второй аргумент — целое от 1 и только у `p`/`row`; `N` считает текущий элемент и берёт следующие элементы того же типа у того же родителя (другие элементы между ними пропускаются и остаются); элементов меньше — удаляется сколько есть.
  - Сочетание элемента и формата проверяется до сборки, независимо от условия и данных. Если вокруг метки нет нужного элемента (`drop(row)` вне таблицы, `drop(img)` не в картинке) — ошибка `Для drop(<эл>) метка должна стоять …` с меткой в `Source`, также независимо от условия (по каждой выведенной метке). HTML, XML, TXT и прочие форматы — `drop(<эл>) не поддерживается в <формат>`.
  - DOCX: `img`/`shape`/`chart` — ближайший `w:drawing` с картинкой (`pic:pic`) / фигурой (`wps:wsp`, `wpg:wgp`, `wpc:wpc`) / диаграммой (`c:chart`); если он в `mc:AlternateContent`, удаляется весь блок вместе с запасным VML. PPTX: `img` — `p:pic`, `shape` — `p:sp`/`p:cxnSp`/`p:grpSp`, `chart` и `table` — `p:graphicFrame`. ODF: `img` и `chart` — `draw:frame` с `draw:image` / `draw:object`, `shape` — фигуры `draw:*` и текстовый фрейм.
  - `drop(col)`: номер столбца — по позиции ячейки в строке (в ODF с учётом `number-columns-repeated`, повтор уменьшается); удаляются ячейки во всех строках таблицы и описание столбца (`w:gridCol`, `a:gridCol`, `table:table-column`, в XLSX — сдвиг диапазонов `<col min max>`). Объединение по горизонтали (`gridSpan`, `hMerge`, `gridBefore/After`, `number-columns-spanned`) — ошибка шаблона; в XLSX лист с форматированной таблицей (`tableParts`, «Форматировать как таблицу») — тоже ошибка шаблона (заголовки и диапазон таблицы хранятся в `xl/tables/*.xml`, Excel «восстанавливал» бы файл). Обе проверки — у каждой метки `drop(col)`, независимо от условия. В XLSX объединения ячеек, `dimension`, автофильтр и условное форматирование не пересчитываются; `<cols>` без оставшихся `<col>` удаляется.
  - `cumSum`, `cumCount`, `count()` считают и строки, удалённые `drop(row)` (удаление идёт после сборки); для сплошной нумерации — фильтр цикла.
  - Ограничения: абзац DOCX с разрывом раздела (`w:sectPr` в `w:pPr`) удаляется вместе с разрывом; во встроенных в DOCX таблицах диаграмм и в имени отчёта `drop` не поддерживается.
- Справка: раздел «Условия» получает примеры `drop(row)`, `drop(p)`, `keep(p)`; из «Недоступно» убираются.

### 31.3 Не входит
- Сортировка по убыванию: в Carbone её нет (документация — «скоро в v5»), синтаксис не опубликован; своё расширение может разойтись с будущим синтаксисом Carbone. Остаётся SQL `ORDER BY … DESC` (пример в справке сохраняется). Решение контроллера 2026-10-10, владелец уведомляется.
- `drop(div|span)` (вывод HTML не поддерживается продуктом).

### 31.4 Выпуск
Ветка `feat/2.2.0` (от `feat/2.1.0`); запись в CHANGELOG; слияние и тег `v2.2.0` — с разрешения владельца.

## 32. 2.4.0: изображения из данных, штрихкоды, цвета, ссылки

Вторая группа платных функций EE (§30.5). Справочник — `notes/2026-10-10-ee-images-barcodes-colors.md` (открытая документация carbone.io; эталона EE нет). Где документация молчит, решение записано здесь; тесты свои (`packages/carbone/test/test.ee-paid.js`).

### 32.1 Изображения из данных
- Заглушка — картинка в шаблоне, тег в её замещающем тексте: DOCX/XLSX/PPTX — title, description или alt; ODT — alt или description; ODS/ODP — title. Значение — data URI `data:image/(png|jpeg|gif);base64,…` или URL `http(s)://` (§32.2). Тег, который занимает весь замещающий текст (без учёта пробелов), или тег с `:barcode`/`:imageFit` — тег изображения: значение-изображение заменяет картинку, сам текст тега из свойств картинки убирается. Смешанный текст («Фото {d.name}») печатается как в 2.3.0. Значение тега изображения, которое не начинается с `data:` или `http(s)://`, печатается в замещающем тексте как в 2.3.0, картинка остаётся (итоговое ревью 2.4.0).
- Форматы изображений: PNG, JPEG, GIF. SVG в 2.4.0 не поддерживается (нужна растровая замена для Word) — ошибка шаблона/данных «SVG не поддерживается».
- `:imageFit(fillWidth|contain|fill)`, по умолчанию `fillWidth`: размер рамки заглушки — граница; `fillWidth` — ширина рамки, высота по пропорциям; `contain` — вписать с пропорциями; `fill` — растянуть. Размеры изображения определяются по заголовку файла (библиотека `image-size`, MIT).
- Циклы: несколько изображений в цикле — для DOCX (обтекание «в тексте») и ODT (привязка «как символ»); для прочих форматов — как в справочнике (абсолютное позиционирование в цикле не поддерживается).
- Пустое значение (`null`, `undefined`, `''`): заглушка удаляется (как `drop(img)`). Неверный data URI, неподдержанный тип, хост вне белого списка — ошибка шаблона с меткой (400, как прочие ошибки шаблона). Сбой загрузки по сети (тайм-аут, код ответа не 2xx, превышение размера) — заглушка удаляется, в журнал API пишется предупреждение (адрес без query-строки), отчёт строится.
- Лимиты: одно изображение — до 10 МБ после декодирования и до 100 млн пикселей (ширина × высота); все изображения отчёта — до 50 МБ; превышение — ошибка шаблона.
- `:autoOrient` остаётся недоступным.

### 32.2 Загрузка изображений по URL
- По умолчанию выключена. `IMAGE_URL_ALLOWLIST` — список хостов через запятую (точное совпадение имени, без масок; порт — часть хоста только если указан). Пустой — любые URL дают ошибку «загрузка изображений по адресу выключена (IMAGE_URL_ALLOWLIST)».
- Только `https:` и `http:`; без перенаправлений (3xx — сбой загрузки); тайм-аут 5 с на изображение (`IMAGE_URL_TIMEOUT_MS`); не более 4 одновременных загрузок на отчёт; адреса, которые разрешаются в частные/локальные IP, не запрещаются отдельно — доверие задаёт белый список (записано в README).
- Загрузка выполняется после сборки документа: теги вычисляются при сборке, затем собираются адреса, загружаются изображения и вставляются в документ; всё — в потоке рендера, в пределах `RENDER_TIMEOUT_MS`.
- Compose и чарт: переменная/значение `imageUrlAllowlist` (по умолчанию пусто).

### 32.3 Штрихкоды
- `:barcode(тип, опция:значение, …)` в замещающем тексте картинки-заглушки (как изображение); результат — PNG, вставляется по правилам §32.1 (`imageFit` применим). Типы — все, что поддерживает `bwip-js` (MIT; имена совпадают с документацией Carbone). Опции из справочника: `width`, `height` (мм), `scale` (1–10, по умолчанию 3), `includetext`, `textsize`, `textxalign`, `textyalign`, `rotate` (N/R/L/I), `barcolor`, `textcolor`, `backgroundcolor` (`#RRGGBB`), `eclevel` (QR). `svg:true` игнорируется (вывод PNG).
- Штрихкод шрифтом (legacy) не поддерживается. Пустое значение — заглушка удаляется. Недопустимые данные или тип — ошибка шаблона с меткой и текстом причины.
- Тег `:barcode` в обычном тексте (не в картинке) — ошибка шаблона «штрихкод ставится в замещающий текст картинки».

### 32.4 Цвета
- `:color(scope, type)`: scope `p` (по умолчанию), `cell`, `row`, `shape`, `part` (только ODT); type `text` (по умолчанию), `highlight`, `background`, `border` (только `shape`). Поддержка по форматам — как в справочнике §3: DOCX — `text`, `background`; ODT/ODP — `text`, `highlight`, `background`; PPTX — всё, `border` для фигур; XLSX/ODS — ошибка «color не поддерживается в XLSX/ODS». Неподдержанное сочетание — ошибка шаблона.
- Цвет — 6 hex-цифр с `#` или без; иначе `#888888` (как в документации). Тег ничего не печатает.
- `bindColor` — не реализуется (устарел); поведение прежнее (тег удаляется, цвет не меняется), в справке — указание использовать `:color`.

### 32.5 Ссылки
- Динамический адрес ссылки (уже работает в CE) проверяется: без схемы — добавляется `https://`; допустимые схемы `http`, `https`, `mailto`, `tel`; домен по правилам справочника §4. Недопустимый адрес (в т. ч. `javascript:`, `data:`) заменяется значением `:defaultURL(...)`, а без него — пустой ссылкой `#` (не адресом carbone.io).
- Адрес из статической части и тегов (`https://site/?id={d.id}`) проверяется целиком; значения тегов после статической части кодируются (`encodeURIComponent`), тег в самом начале адреса (`{d.base}/items/{d.id}`) вставляется как есть. Относительные адреса и якоря (`#раздел`, `../файл.pdf`) — недопустимы, `#`.
- `:defaultURL(адрес)` или `:defaultURL(.поле)`: подставляется, если значение пустое или недопустимое. В адресе ссылки аргумент тоже проверяется; недопустимый — `#`. В обычном тексте (не в адресе ссылки) значение подставляется как есть, без проверки.

### 32.6 Не входит
`:autoOrient`, SVG, штрихкоды шрифтом, `bindColor`, `failOn`, изображения в HTML-выводе.

### 32.7 Выпуск
Ветка `feat/2.4.0` от `main` после 2.3.0 (§33 сдвинул нумерацию); CHANGELOG; слияние и тег `v2.4.0` — с разрешения владельца.

## 33. 2.3.0: перенос шаблонов между средами

Решения владельца (2026-10-10): источник данных — по имени, иначе выбор в окне загрузки; при совпадении имени — выбор в окне загрузки (обновить / копия / пропустить); переносятся категория, группы доступа, публичность и формат по умолчанию.

### 33.1 Архив
- Файл `<имя>.crt.zip` (один шаблон) или `templates-<дата>.crt.zip` (несколько). Внутри: `manifest.json` и `templates/<n>/template.<ext>` (файл документа текущей версии).
- `manifest.json`: `{ format: "carbone-reports/templates", formatVersion: 1, appVersion, exportedAt, templates: [...] }`. Элемент: `name`, `description`, `fileExt`, `defaultOutput`, `public`, `category` (имя или `null`), `groups` (имена), `datasource` — `{ name, host, port, database, username, sslMode }` (только для сведения и сопоставления; пароль и CA не выгружаются), `queries` (`key`, `sql`, `mode`, `sortOrder`), `params` (все поля `template_params`, кроме `id`/`templateId`), `file` (путь в архиве), `sha256` файла.
- Идентификаторы, даты, авторы, история запусков, ошибки сохранения не выгружаются.

### 33.2 API (только администраторы)
- `POST /api/templates/export` `{ ids: uuid[] }` (1–200) → `application/zip`, `Content-Disposition: attachment`. Несуществующий id — 404.
- `POST /api/templates/import/preview` (multipart, поле `file`) → план: для каждого шаблона архива — `index`, `name`, `existing` (список кандидатов с тем же именем `{ id, name, updatedAt }`, новые первыми; `updatedAt` — ISO UTC с микросекундами; пустой — совпадения нет), `datasourceMatch` (id источника с тем же именем или `null`), `missingGroups`, `categoryExists`, ошибки проверки. Ничего не меняет.
- `POST /api/templates/import` (multipart: `file` + `decisions` JSON `[{ index, action: 'create'|'update'|'copy'|'skip', datasourceId, targetId, targetUpdatedAt }]`) → применяет в одной транзакции БД; импорты сериализуются advisory-блокировкой. Файлы пишутся в хранилище внутри транзакции (для `update` — под блокировкой строки `FOR UPDATE`, а не до неё) и удаляются при откате. Результат: по шаблону — итог и id.
  - `create` — только если имени нет (имя появилось после предпросмотра — 409); `update` — существующий шаблон, `targetId` (один из `existing`) и `targetUpdatedAt` (его `updatedAt` из предпросмотра, без изменений) обязательны; если шаблон изменён (`updated_at` отличается: файл, сохранение в OnlyOffice, запросы, параметры, метаданные, доступ), удалён или переименован после предпросмотра — 409: файл — новая версия (`version + 1`, новый `docKey`, как при загрузке файла), запросы и параметры заменяются, метаданные обновляются, история запусков сохраняется; `copy` — новый шаблон с именем `«<имя> (2)»` (первое свободное число); `skip`.
  - Категория создаётся по имени, если её нет (в том числе удалённая после предпросмотра). Группы — по имени; отсутствующие пропускаются (они перечислены в предпросмотре; удалённая после предпросмотра тоже пропускается).
  - `datasourceId` обязателен для всех, кроме `skip`; источник удалён после предпросмотра — 409.
- Конфликты при одновременных изменениях (источник, группа, категория удалены во время транзакции, deadlock, шаблон изменился после предпросмотра, имя занято) — 409 `CONFLICT`. Повтор имени шаблона внутри одного архива отклоняется (при выгрузке — 400, при загрузке — 400 `IMPORT_INVALID`). Ручное создание шаблона блокировку импорта не берёт: гонка с импортом может дать дубль имени (принято).
- Проверки архива: размер до 50 МБ, распакованный объём до 200 МБ (из них `manifest.json` до 20 МБ; выгрузка проверяет манифест той же схемой и тем же лимитом, чтобы архив загружался), не более 1000 записей, пути без `..` и абсолютных, только ожидаемые файлы, `formatVersion` 1, расширения шаблонов из допустимых, `sha256` совпадает, поля проверяются теми же схемами, что при ручном создании (ключи запросов, типы параметров). Ошибка — 400 `IMPORT_INVALID` с причиной на русском.
- Режим обслуживания: оба маршрута импорта под ним недоступны (как прочие изменения); экспорт доступен. Экспорт: одновременно не больше 2 на процесс (остальные ждут очереди); файлы шаблонов кладутся в zip без сжатия (STORE — docx/xlsx уже сжаты).

### 33.3 Интерфейс
- Список шаблонов администратора: выбор нескольких (флажки) и кнопка «Выгрузить»; в карточке шаблона — «Выгрузить».
- Кнопка «Загрузить из архива» → окно: выбор файла → таблица предпросмотра (имя; действие — по умолчанию «создать», а при совпадении — «обновить»; источник — найденный по имени или выбор; предупреждения: нет групп, будет создана категория) → «Загрузить» → итог по строкам. При 409 — «Повторить предпросмотр»: выбор по строкам (действие, источник, обновляемый шаблон) сохраняется, где он ещё допустим; иначе — выбор по умолчанию, строка помечается. У «обновить» — подпись, что файл, запросы, параметры, группы, категория, публичность и источник будут заменены.

### 33.4 Выпуск
Ветка `feat/2.3.0` от `main` (2.2.0); CHANGELOG и README («Перенос шаблонов между средами»); слияние и тег `v2.3.0` — с разрешения владельца.

## 34. 2.5.0: нативные диаграммы DOCX/XLSX и `:html`

Третья группа платных функций EE (§30.5, сдвиг 2026-10-11). Поведение — по открытой документации carbone.io (разделы Charts и HTML); эталона EE нет: проба 2026-10-11 показала, что EE 5.15.3 без лицензии обрабатывает диаграммы как обычный XML (у всех точек `idx="0"`, `ptCount` и диапазоны не меняются) — так же, как наш движок до 2.5.0, а `:html` отключает. Тесты свои (`packages/carbone/test/test.ee-charts.js`, `test.ee-html.js`).

### 34.1 Нативные диаграммы: шаблон
- Диаграмма рисуется в Word или Excel; метки ставятся в таблицу данных диаграммы строками цикла, как в обычной таблице: `{d.rows[i].m}` / `{d.rows[i+1].m}` (по документации Carbone на каждое выражение `[i]` — своё `[i+1]` в следующей строке). DOCX — во встроенном листе (`word/embeddings/*.xlsx`, «Изменить данные»); XLSX — в ячейках листа, на которые ссылается диаграмма (`xl/charts/chartN.xml`).
- Типы: все диаграммы `c:chartSpace` — гистограммы и линейчатые, графики, с областями, круговые и кольцевые, точечные и пузырьковые, комбинированные, 2D и 3D (ряды `c:cat`/`c:val`/`c:xVal`/`c:yVal`/`c:bubbleSize`/`c:tx`).
- Ряды фиксированы шаблоном (число рядов из данных не выводится); цикл — только по строкам.

### 34.2 Нативные диаграммы: обработка
- При сборке листа (основного XLSX или встроенного в DOCX) движок запоминает отображение строк шаблона в строки результата: каждая строка шаблона → `[первая, последняя]` строка результата; строка `[i+1]` и строки цикла отображаются на весь диапазон строк цикла; строки после цикла сдвигаются.
- После сборки в каждой диаграмме, чьи данные лежат на этом листе: каждая ссылка `c:f` вида `Лист!$A$2:$A$3` (имя листа в кавычках или без, абсолютные и относительные адреса) пересчитывается: начало — первая строка результата для начальной строки шаблона, конец — последняя строка результата для конечной. Ссылки на другие листы — по отображению своего листа. Ссылки-объединения `(A,B)`, именованные диапазоны и ссылки на внешние книги не меняются.
- Кэш (`c:strCache`, `c:numCache`, `c:multiLvlStrCache` не поддерживается — остаётся как есть) перестраивается из значений уже заполненного листа по новому диапазону: точки `c:pt` с `idx` по порядку от 0, `ptCount` — число ячеек диапазона, `formatCode` сохраняется; в `c:numCache` нечисловые и пустые ячейки — без точки. Кэш строится из листа, а не из меток в XML диаграммы, поэтому одинаково работают шаблоны, где Word сохранил метки в кэше, и где нет.
- Пустой цикл (0 строк): диапазон — первая строка цикла (одна пустая ячейка), `ptCount` 0.
- Числа: ячейка, попавшая в числовой ряд (`c:numRef`), становится числовой (`t="n"`), если её значение похоже на число — после удаления пробелов и неразрывных пробелов `-?\d+([.,]\d+)?([eE][-+]?\d+)?` (запятая как десятичный разделитель); иначе остаётся текстом. `:formatN` в XLSX работает как раньше. Прочие ячейки не меняются.
- DOCX: изменённый встроенный лист пишется обратно в `word/embeddings` (в Word «Изменить данные» показывает данные отчёта). Диаграммы, привязанные к внешнему файлу (без встроенного листа), обрабатываются как обычный XML.
- Не входит: диаграммы Office 2016 (`cx:chartSpace`: иерархические, гистограмма, ящик с усами), циклы по столбцам, ряды из данных, диаграммы PPTX/ODT/ODS/ODP, таблицы Excel (`xl/tables`) и именованные диапазоны (не расширяются).

### 34.3 `:html`: где работает и как вставляется
- DOCX и ODT: тело, ячейки таблиц, колонтитулы; PDF — конвертацией из них. В HTML-шаблонах значение вставляется без экранирования. XLSX, PPTX, ODS, ODP — ошибка шаблона `html не поддерживается в <формат>.` (400).
- Механизм как у `drop`/изображений 2.4.0: форматер печатает служебную метку, после сборки она заменяется XML. Разбор HTML — `htmlparser2` (MIT, точная версия), сущности — его же декодером: именованные, `&#169;`, `&#x1F600;`; `&#9;` схлопывается в пробел, табуляция — `&ensp;`/`&emsp;`.
- Без параметров HTML встаёт отдельными абзацами на месте метки; текст абзаца до и после метки — в свои абзацы с тем же оформлением (пустые не создаются). После каждого абзаца, заголовка, списка, таблицы и `pre` — пустой абзац; `nospace` его убирает.
- `inline`: внутри текущего абзаца; работают `a`, `b`, `strong`, `em`, `i`, `s`, `del`, `u`; остальные теги отбрасываются, текст остаётся (`br` и границы блоков — пробел; `pre` — переносы строк становятся пробелами).
- Параметры через запятую: `inline`, `nospace`, `headingtheme:<префикс>`, `tabletheme:<стиль>` (DOCX), `quotetheme:<стиль>`. Неизвестный параметр — ошибка шаблона.
- Наследование: шрифт, размер, цвет текста и фона, выравнивание, направление (RTL) — от метки; если свойство задано и в HTML, приоритет у метки.
- `null`, `undefined`, `''` — ничего (абзац с одной меткой остаётся пустым, как у обычной метки). Значение длиннее 1 МБ (UTF-8) или с вложенностью глубже 32 — ошибка шаблона.
- `{o.preReleaseFeatureIn=…}` допускается и ни на что не влияет: все функции этого раздела включены всегда.

### 34.4 `:html`: теги
- Текст: `b`/`strong`, `i`/`em`, `u`, `s`/`del`, `sup`, `sub`; `mark` — жёлтая заливка (её `background-color` не меняет); `code`, `kbd`, `samp` — Courier New.
- Структура: `p`, `br`; `pre` — Courier New, переносы строк и пробелы сохраняются; `hr` — абзац с нижней линией, отступ 0,5em сверху и снизу; `blockquote` — отступ 40px на уровень (накапливается) либо стиль `quotetheme` (в ODT имя как хранится: `Intense_20_Quote`).
- Списки `ul`/`ol`/`li` с вложенностью: DOCX — определения в `numbering.xml` (часть, связь и тип содержимого создаются при отсутствии), маркеры •/◦/▪ и номера 1./a./i. по уровням; ODT — автоматические стили списков.
- Заголовки `h1`–`h6`: стили `Heading1`…`Heading6` (ODT — `Heading_20_1`…, `text:h` с `outline-level`) или `<префикс>1`…`6` из `headingtheme`; отсутствующий стиль создаётся простым (жирный, кегль 20/16/14/13/12/11 пт). DOCX: заголовок внутри `li` — текст с оформлением заголовка в пункте списка.
- Таблицы `table`/`tr`/`th`/`td`, `colspan`, `rowspan`: ширина — ширина текста раздела, столбцы равные; `th` — жирный. DOCX: стиль `tabletheme`, иначе стиль таблиц по умолчанию документа, иначе `TableGrid` (создаётся при отсутствии: сплошные чёрные границы). ODT — тонкие сплошные границы. `tbody`/`thead`/`tfoot`/`caption` — их строки берутся как обычные, подпись — абзацем перед таблицей.
- Ссылки `a href` — по правилам §32.5 (проверка, `#` или `:defaultURL(...)`: `{d.x:defaultURL('https://site.ru'):html}`).
- Изображения `img`: `src` — data URI или URL из `IMAGE_URL_ALLOWLIST` (§32.1–32.2, те же форматы и лимиты, общие с прочими изображениями отчёта); размер — `width`/`height` в пикселях (96 dpi; один задан — второй по пропорциям); без них — ширина 5 см с пропорциями. Неверный data URI, хост вне списка, сбой загрузки — картинка пропускается, предупреждение в журнал API, отчёт строится.
- Флажки `input type="checkbox"` (`checked`, `checked=""`, `checked="checked"`): DOCX — флажок Word (`w14:checkbox`, кликабельный); ODT/PDF — ☒/☐. В пункте списка с флажком маркер/номер не выводится.
- Стили (только атрибут `style`): `color`, `background-color` — hex (3/6 цифр), `rgb()`, `hsl()` (с запятыми или пробелами), именованные цвета CSS; неверное значение пропускается. `break-before: page`, `break-after: page` — разрыв страницы до/после блока. `<style>`, классы, id и прочие свойства игнорируются.
- Прочие теги и атрибуты отбрасываются, текст сохраняется; `script`, `style`, `head`, `title` — вместе с содержимым.

### 34.5 Справка, совместимость, выпуск
- `community.js`: `html` убирается из отключённых; `chart` остаётся отключённым (ECharts — следующий выпуск). Справка: раздел «Диаграммы» (нативные) и «HTML»; из «Недоступно» убирается `na-html`, `na-chart` остаётся с пояснением про нативные диаграммы.
- Интеграционный тест: DOCX с диаграммой и с `:html` конвертируется в PDF через OnlyOffice; в PDF есть текст подписей категорий и HTML.
- Ветка `feat/2.5.0` от `main` (2.4.0); CHANGELOG, README; слияние и тег `v2.5.0` — с разрешения владельца.

## 35. 2.6.0: графики ECharts (`:chart`) и конструктор графиков

Четвёртая группа платных функций EE (очередь 2026-10-14, §30). Поведение `:chart` — по открытой документации carbone.io (раздел Charts, «ECharts 5»); эталона EE нет, код образа EE не читается, тесты свои (`packages/carbone/test/test.ee-echarts.js`). Решения владельца 2026-10-14: свой конструктор графиков в редакторе шаблона (вариант B: конструктор плюс готовое описание ECharts из данных), базовый набор типов, «ряды из данных» — сразу; архитектура — формат `:chart` в движке (вариант 1).

### 35.1 `:chart` в шаблоне
- Заглушка — картинка в шаблоне, тег `{d.x:chart}` в её замещающем тексте, по правилам §32.1 (те же атрибуты, тег занимает весь замещающий текст). Форматы: DOCX, XLSX, PPTX, ODT, ODS, ODP. `:imageFit` применим (по умолчанию `fillWidth`). Тег `:chart` в обычном тексте — ошибка шаблона «график ставится в замещающий текст картинки».
- Значение — объект по документации Carbone: `{ type?, width?, height?, theme?, option }`.
  - `type` — `echarts@v5` или `echarts@v5a` (оба рисуются ECharts 5); нет — `echarts@v5`; иное — ошибка «неизвестный тип графика».
  - `option` — описание ECharts (обычный JSON; функций в JSON нет). Объект без `type` и `option`, но с `series`, считается голым `option` (удобно для SQL).
  - `theme` — `null`, `'dark'` или объект темы ECharts.
  - `width`/`height` — логический размер холста в пикселях (100–4000). Нет — размер рамки заглушки в пикселях при 96 dpi. Шрифты ECharts задаются в логических пикселях, поэтому `width`/`height` меняют относительный размер текста; картинка вписывается в рамку по `imageFit`.
  - Значение-строка разбирается как JSON; ошибка разбора — ошибка «описание графика — не JSON».
- Пустое значение (`null`, `undefined`, `''`) — заглушка удаляется (§32.1).

### 35.2 Отрисовка
- Через загрузчик картинок движка (`media.js`, вид `chart`, как `barcode`): формат печатает метку, после сборки документ получает PNG. В потоке рендера, в пределах `RENDER_TIMEOUT_MS`.
- ECharts 5 (`echarts`, Apache-2.0) в режиме SSR: `renderer: 'svg'`, `ssr: true`, анимация выключена; `renderToSVGString()`. SVG переводится в PNG `@resvg/resvg-js` (MPL-2.0) с масштабом 2 (чёткость при печати; если сторона больше 2000 px — масштаб 1), `loadSystemFonts: false`.
- Картинки в описании и теме: строки `image://…` и значения ключей `image` (`graphic`, `symbol`, узоры, фон) — только `data:image/(png|jpeg|gif);base64,…`, и начало содержимого совпадает с типом (сигнатура PNG, JPEG, GIF), иначе ошибка шаблона «график: картинки в описании — только data:image/png|jpeg|gif;base64». После SSR SVG разбирается (htmlparser2, XML), проверяется и записывается заново, resvg получает только запись из проверенного дерева (ECharts не экранирует кавычки и `<>` в атрибутах): элементы — только из списка ECharts SSR (`<style>` с `:hover` отбрасывается), `href` — только такой data URI (иначе та же ошибка), `url()` — только `url(#id)`, `xmlns` — только у корня, атрибуты `xml:*` (кроме `xml:space`) и `src` запрещены; прочее — ошибка «график: недопустимое содержимое SVG». resvg читает пути с диска сервера, поэтому иначе нельзя.
- Шрифт — Noto Sans Regular и Bold (OFL), файлы в `packages/carbone/assets/fonts`, `fontFamily` по умолчанию в описании — `Noto Sans`; другие семейства в описании рисуются им же. Результат не зависит от шрифтов сервера.
- Фон по умолчанию — белый (`backgroundColor` в описании переопределяет; `transparent` допустим).
- Лимиты: описание после `JSON.stringify` — до 1 МБ; в сумме по рядам — до 10 000 точек, рядов — до 20; одна отрисовка — до 5 с (иначе ошибка «график рисуется дольше 5 с»); PNG входит в общий лимит изображений отчёта (§32.1, 50 МБ). Превышение — ошибка шаблона с меткой.
- Ошибки описания (ECharts бросает при `setOption`) и сбой отрисовки — ошибка шаблона `400` `CARBONE_TEMPLATE` «ошибка шаблона: график {тег}: …».
- `community.js`: `chart` убирается из отключённых.

### 35.3 Конструктор: модель
- Таблица `template_charts` (миграция 0007): `id`, `template_id` (каскадное удаление), `key`, `sort_order`, `config jsonb`; уникальность `(template_id, key)`.
- Схема `TemplateChart` в `packages/shared` (zod, строгая):
  - `key` — `^[a-zA-Z_][a-zA-Z0-9_]*$`, до 64 символов, уникален в шаблоне; графиков в шаблоне — до 20.
  - `query` — ключ запроса шаблона с режимом `list`.
  - `type` — `bar`, `barHorizontal`, `line`, `area`, `pie`, `doughnut`, `combo`.
  - `stacked` (bar/barHorizontal/line/area), `smooth` (line/area/combo-линии) — булевы, по умолчанию `false`.
  - `category` — колонка подписей.
  - `series` — 1–20 рядов `{ column, name?, color?, kind?, axis? }`: `name` — название (нет — имя колонки), `color` — `#RRGGBB` (нет — из палитры), `kind` — `bar|line` (только `combo`, по умолчанию `bar`), `axis` — `left|right` (только `combo`, по умолчанию `left`).
  - `splitBy` — колонка «ряды из данных» (необязательно): тогда `series` ровно из одного ряда, он задаёт колонку значений и вид/ось; ряды — различные значения `splitBy` в порядке первого появления, названия — эти значения; больше 20 — ошибка отчёта «больше 20 рядов».
  - `pie`/`doughnut`: ровно один ряд, `splitBy` и `stacked` запрещены.
  - Оформление: `title` (до 200 символов), `legend` — `none|top|bottom|right` (по умолчанию `bottom`), `labels` — подписи значений (по умолчанию `false`), `palette` — `default|contrast|pastel|mono` (четыре набора цветов в `packages/shared`), `number` — `{ decimals 0–6 (по умолчанию не задано — как есть), thousands: boolean, suffix до 10 символов }`, `axisX`, `axisY`, `axisY2` — названия осей (до 100 символов; `axisY2` — только `combo` с рядом на правой оси).
- Проверки при сохранении (`400` `VALIDATION`, ошибки по полям): схема; `query` существует и имеет режим `list`; колонки не проверяются (известны только после выполнения запроса). Запрос с ключом `charts` при наличии графиков — ошибка «ключ charts занят графиками» (и при сохранении запросов, и при сохранении графиков).

### 35.4 Конструктор: описание ECharts
- Чистая функция `buildChartOption(config, rows)` в `packages/shared` возвращает объект `{ type: 'echarts@v5', option }`; её используют API (отчёт и предпросмотр) и вкладка «Графики» (предпросмотр в браузере).
- Подписи: значение колонки `category` как строка; дата (`Date` или строка `ГГГГ-ММ-ДД[T…]`) — `ДД.ММ.ГГГГ`; `null` — пустая строка.
- Значения: число; строка, похожая на число (`-?\d+(\.\d+)?([eE][-+]?\d+)?`, как отдаёт Postgres `numeric`) — число; иначе `null` (пропуск точки). Колонки нет в строках — ошибка отчёта «график {key}: нет колонки {column}» (`400` `CARBONE_TEMPLATE`).
- `splitBy`: категории — различные значения `category` в порядке первого появления; для пары (категория, ряд) без строки — `null`; повтор пары — берётся последняя строка.
- Типы: `bar` — вертикальные столбцы; `barHorizontal` — оси поменяны; `line`; `area` — линия с `areaStyle`; `stacked` — общий `stack`; `pie` — `radius: '70%'`; `doughnut` — `radius: ['40%','70%']`; `combo` — ряды по `kind`, правая ось `yAxis[1]`, если есть ряд с `axis: right`.
- Формат чисел — одна функция для подписей значений, осей и подсказок: `decimals` (округление), `thousands` (неразрывный пробел), `suffix` (через неразрывный пробел, например `₽`, `%`).
- Данные: после `buildReportData` для каждого графика шаблона `data.charts[key] = buildChartOption(config, data[query])` — и в отчёте, и в предпросмотре (`collectReportData`); если графиков нет, `data.charts` не создаётся. Пустой результат запроса — пустой график (оси без точек), а не удаление заглушки.

### 35.5 Вкладка «Графики»
- Новая вкладка редактора шаблона между «Данные» и «Параметры» (`?tab=charts`). Слева список графиков («Добавить», «Удалить», порядок перетаскиванием не нужен — по порядку добавления), справа настройки выбранного и предпросмотр.
- Сохранение — как на вкладке «Данные»: кнопка «Сохранить», предупреждение о несохранённых правках, ошибки у полей; `PUT /api/templates/:id/charts` (весь список, роль администратора, как `PUT …/queries`) возвращает `TemplateAdminDetails` с `charts`.
- Колонки (`category`, `series[].column`, `splitBy`) выбираются из колонок последнего выполнения выбранного запроса на тестовых параметрах (тот же запуск, что на вкладке «Данные»: `POST …/queries/run`); пока не выполнялся — кнопка «Выполнить запрос»; сохранённая колонка, которой нет в результате, показывается с пометкой «нет в результате».
- Предпросмотр — `buildChartOption` на этих строках, ECharts в браузере (SVG), 600×360; ECharts загружается отдельным чанком при открытии вкладки.
- Под предпросмотром тег `{d.charts.<key>:chart}` с кнопкой «Скопировать» и подсказкой: вставьте картинку-заглушку в документ, тег — в её замещающий текст; размер картинки — размер графика.
- Панель тегов вкладки «Документ» показывает теги графиков (`{d.charts.<key>:chart}`).

### 35.6 Перенос шаблонов
- `TransferTemplate` получает необязательный `charts: TransferChart[]` (`key`, `sortOrder`, `config`; ключи уникальны); `formatVersion` остаётся 1; архив без `charts` — шаблон без графиков. Экспорт пишет `charts` всегда (пустой массив, если нет). Импорт проверяет `config` той же схемой; запрос графика должен быть в шаблоне архива.

### 35.7 Справка, образ, тесты, выпуск
- Справка по шаблонам — раздел «Графики ECharts» (заглушка в Word/Excel/LibreOffice, конструктор, готовое описание из SQL с примером `json_build_object`, ограничения); из «Недоступно» убирается `na-chart`. README — раздел про графики; CHANGELOG 2.6.0 с изменением размера образа API.
- Образ API: зависимости `echarts`, `@resvg/resvg-js` (готовые сборки linux-x64/arm64 gnu, Debian bookworm), шрифты в пакете. NOTICE — лицензии echarts (Apache-2.0), resvg-js (MPL-2.0), Noto Sans (OFL).
- Тесты: `packages/carbone` — `:chart` во всех шести форматах (PNG вставлен, размеры по рамке), `width`/`height`, голый `option`, пустое значение, строка JSON, ошибки и лимиты, `:chart` в тексте; `packages/shared` — `buildChartOption` для всех типов, `splitBy`, числа-строки, даты, пропуски, формат чисел; API — сохранение и проверки графиков, ключ `charts`, `d.charts` в отчёте и предпросмотре, перенос туда-обратно; web — вкладка, выбор колонок, предпросмотр, несохранённые правки, тег; интеграционный — DOCX с графиком переводится в PDF через OnlyOffice.
- Ветка `feat/2.6.0` от `main` (2.5.1); слияние и тег `v2.6.0` — с разрешения владельца.

## 36. 2.7.0: PDF — PDF/A, водяной знак, нумерация, метаданные, приложенные файлы

Пятая группа платных функций EE (очередь 2026-10-14, §30). Решения владельца 2026-10-15: PDF-функции делятся на три выпуска по очереди — 2.7.0 (этот раздел), 2.7.1 — пароль и ограничения (печать, копирование, изменение), 2.7.2 — электронная подпись (вид подписи, в том числе ГОСТ, обсуждается перед выпуском). В 2.7.0: склейка — только постоянные PDF-файлы шаблона (вариант A; PDF из данных и пакетная склейка отчётов — нет); поля настроек допускают простые теги (вариант B); водяной знак, нумерация и метаданные действуют на весь итоговый документ вместе с приложенными файлами (вариант A); архитектура — обработка готового PDF в API библиотекой `pdf-lib` (вариант 1; Ghostscript отвергнут из-за AGPL, вставка в колонтитулы до конвертации — из-за вмешательства в вёрстку). Эталона EE нет, код образа EE не читается.

### 36.1 Настройки PDF шаблона
- Колонка `templates.pdf_options jsonb` (миграция 0008), по умолчанию `{}`; схема `PdfOptions` в `packages/shared/src/pdf-options.ts` (zod, строгая, все блоки необязательны):
  - `pdfa` — `false` (по умолчанию) или `true`: PDF/A-2b.
  - `watermark` — `{ text, opacity, color, angle }`: `text` — 1–200 символов (с тегами); `opacity` — 10–50 (%), по умолчанию 20; `color` — `gray|red|blue`, по умолчанию `gray` (`#808080`, `#C00000`, `#1F4E9A`); `angle` — `diagonal|horizontal`, по умолчанию `diagonal`. Размер шрифта подбирается так, чтобы строка занимала 80 % диагонали (или ширины для `horizontal`) страницы, не больше 120 пт.
  - `pageNumbers` — `{ format, position, skipFirst }`: `format` — 1–100 символов, по умолчанию `Стр. {page} из {pages}`, обязателен `{page}`; `position` — `bottom-center|bottom-right|top-right`, по умолчанию `bottom-center`; `skipFirst` — по умолчанию `false`. Шрифт 9 пт, цвет `#404040`, отступ от края 24 пт (с учётом CropBox).
  - `metadata` — `{ title, author, subject, keywords }`, каждое до 500 символов (с тегами); пустой `title` — имя шаблона.
- Символы, которых нет ни в Noto Sans Regular, ни в Noto Sans SC Regular (с 2.14.0, §45.5), в постоянном тексте полей — ошибка `400 VALIDATION` у поля «символ … не поддерживается шрифтом PDF» (проверка по cmap шрифта в API).
- `PUT /api/templates/:id/pdf-options` (администратор) — сохраняет весь объект, возвращает `TemplateAdminDetails` с `pdfOptions` и `attachments`.

### 36.2 Теги в полях
- В `watermark.text`, `metadata.*` (и только в них) заменяются простые пути `{d.a.b}`, `{d.items[0].name}` — функция `fillPdfText(text, data)` в `packages/shared`. Форматтеров нет: `{d.x:format}` остаётся как есть и при сохранении — ошибка «в полях PDF теги без форматтеров».
- Значение: строка — как есть; число и булево — `String()`; `null`, `undefined`, объект, массив, неизвестный путь — пустая строка. Дата (`Date` или строка ISO) — как строка из данных.
- Пустой после подстановки (и `trim`) текст водяного знака — водяной знак не ставится; пустой `title` — имя шаблона.
- Символы значений, которых нет в шрифте, заменяются на `?`; управляющие символы — на пробел.
- `{page}`, `{pages}` в `pageNumbers.format` — номер страницы и число страниц итогового документа; теги `{d.…}` в нумерации не поддерживаются.

### 36.3 Приложенные файлы
- Таблица `template_attachments` (миграция 0008): `id uuid`, `template_id` (каскадное удаление), `placement` — `start|end`, `sort_order`, `name` (исходное имя, до 200 символов), `file_path` (S3, `templates/<id>/attachments/<uuid>.pdf`), `size`, `pages`, `pdfa boolean`, `created_at`.
- `POST /api/templates/:id/attachments` (multipart, один файл, `placement`) — `201`; `PATCH …/attachments/:aid` `{ placement?, sortOrder? }`; `DELETE …/attachments/:aid` (файл удаляется из S3 после коммита). Все — администратор, возвращают `TemplateAdminDetails`.
- Проверки при загрузке (`400 VALIDATION`): начинается с `%PDF-` и разбирается `pdf-lib`; без шифрования; до 20 МБ; в шаблоне до 10 файлов и до 500 страниц в сумме; `pdfa` — по XMP `pdfaid:part` ≥ 1 (признак «заявлен PDF/A», не проверка соответствия).
- Правило PDF/A: если `pdfa: true`, все приложения должны иметь `pdfa`. Нарушение — `400` «PDF/A включён: файл «{name}» не в формате PDF/A» — и при сохранении настроек, и при загрузке. Проверка — в транзакции с блокировкой строки шаблона `FOR UPDATE` (как §35, R8).
- Порядок итогового документа: приложения `start` по `sort_order`, отчёт, приложения `end` по `sort_order`.

### 36.4 Сборка итогового PDF
- `renderReport(…, 'pdf', …)` получает настройки шаблона; при `pdfa: true` конвертер вызывается с `outputtype: 'pdfa'` (только для PDF; прочие форматы не меняются).
- Если `pdf_options` пуст (нет `watermark`, `pageNumbers`, `metadata`) и приложений нет — обработки нет, результат байт в байт как в 2.6.0 (при `pdfa` без остального — тоже без обработки).
- Иначе — `postprocessPdf(pdf, { attachments, watermark, pageNumbers, metadata, pdfa })` в `apps/api/src/modules/pdf/` (`pdf-lib` MIT, `@pdf-lib/fontkit` MIT), в пуле рабочих потоков рендера, в пределах срока отчёта (`deadline`):
  1. приложения копируются (`copyPages`) в начало и конец;
  2. водяной знак — на каждой странице поверх содержимого, по центру видимой области (CropBox, иначе MediaBox) с учётом `/Rotate`; шрифт Noto Sans Regular встраивается подмножеством (файлы из `packages/carbone/assets/fonts`); прозрачность — ExtGState `ca`;
  3. нумерация — тем же шрифтом, `skipFirst` пропускает первую страницу итогового документа, номера сквозные;
  4. метаданные — Info (`Title`, `Author`, `Subject`, `Keywords`, `Producer: carbone-reports`, даты создания и изменения) и XMP с теми же значениями; при `pdfa` в XMP сохраняются `pdfaid:part=2`, `pdfaid:conformance=B`; OutputIntent отчёта и `/ID` трейлера сохраняются.
- Результат больше 100 МБ — ошибка `400` «итоговый PDF больше 100 МБ». Файл приложения не читается из S3 — `502` «приложенный файл «{name}» недоступен».
- Где действует: предпросмотр администратора, формирование отчёта (`out.pdf` снимка), скачивание PDF. Прочие форматы («Сохранить как DOCX/XLSX…», предпросмотр данных) — без настроек PDF.
- Снимок запуска: `out.pdf` пишется при создании запуска уже обработанным; в каталог снимка кладётся `pdf-options.json` (настройки на момент запуска) — для истории. Приложения в снимок не копируются: они уже внутри `out.pdf`. Изменение настроек и приложений шаблона не меняет PDF прошлых запусков.

### 36.5 Вкладка «PDF»
- Новая вкладка редактора шаблона после «Графики» (`?tab=pdf`). Блоки: «PDF/A» (переключатель и пояснение), «Водяной знак» (включить; текст, прозрачность, цвет, угол), «Нумерация страниц» (включить; формат, положение, «не нумеровать первую»), «Метаданные» (четыре поля), «Приложенные файлы» (список: имя, страниц, PDF/A, «в начало/в конец», вверх/вниз, удалить; кнопка «Загрузить PDF»).
- Настройки сохраняются кнопкой «Сохранить» с предупреждением о несохранённых правках и ошибками у полей (как «Графики»); приложения — сразу при загрузке, перемещении, удалении.
- Подсказка у полей с тегами: «можно `{d.поле}`, без форматтеров». Результат — на вкладке «Предпросмотр» («Сгенерировать PDF»).

### 36.6 Перенос шаблонов
- `TransferTemplate` получает необязательные `pdfOptions` (та же схема) и `attachments: { file, name, placement, sortOrder, pdfa }[]`; файлы — `templates/<n>/attachments/<i>.pdf` в архиве; `formatVersion` остаётся 1; архив без полей — шаблон без настроек и приложений. Импорт проверяет файлы так же, как загрузка (§36.3), и правило PDF/A; обновление/замена шаблона заменяет его настройки и приложения.

### 36.7 Справка, образ, тесты, выпуск
- Справка по шаблонам — раздел «PDF: PDF/A, водяной знак, нумерация, приложения» (что где действует, теги в полях, требования к приложениям, PDF/A-2b). README — раздел про настройки PDF; CHANGELOG 2.7.0.
- Образ API: `pdf-lib`, `@pdf-lib/fontkit`; NOTICE — их лицензии (MIT). veraPDF — только в CI (в образ не входит).
- Тесты:
  - первая задача плана — проверка риска: DOCX → OnlyOffice `pdfa` → `postprocessPdf` со всеми функциями и приложенным PDF/A → veraPDF (профиль PDF/A-2B) без нарушений; при провале — остановка и решение владельца;
  - `apps/api` модульные: порядок приложений, сквозная нумерация и `skipFirst`, страницы разного размера и с `/Rotate 90`, водяной знак с кириллицей, пустой знак, замена неподдерживаемых символов, Info и XMP, отсутствие обработки без настроек (байт в байт), лимиты;
  - `packages/shared`: схема, `fillPdfText` (пути, индексы, неизвестный путь, объект, форматтер);
  - API: сохранение настроек, правило PDF/A (в том числе одновременные запросы), загрузка/перемещение/удаление приложений и ошибки, настройки в предпросмотре и в отчёте, PDF прошлого запуска не меняется, перенос туда-обратно;
  - web: вкладка, несохранённые правки, приложения, ошибки;
  - интеграционный (CI, OnlyOffice + veraPDF): отчёт с PDF/A, водяным знаком, нумерацией и приложением проходит veraPDF, текст водяного знака и номера страниц есть в PDF.
- Ветка `feat/2.7.0` от `main` (2.6.0); слияние и тег `v2.7.0` — с разрешения владельца.

## 37. 2.7.1: PDF — пароль и ограничения

Второй из трёх PDF-выпусков (§36). Решения владельца 2026-10-15: пароль на открытие — один постоянный на шаблон (вариант A; пароль из данных и пароль на пользователя — нет); ограничения печати, копирования и изменения — флажками, независимо от пароля на открытие (вариант A); шифрование — программой `qpdf` (Apache-2.0) в образе API (JS-библиотеки шифрования отвергнуты как незрелые, шифрование средствами OnlyOffice — как неполное и теряемое при обработке §36.4); PDF/A и защита несовместимы. Эталона EE нет, код образа EE не читается.

### 37.1 Настройки и хранение
- `PdfOptions` (§36.1) получает необязательный блок `protection` — `{ noPrint, noCopy, noModify }`, все `boolean`, по умолчанию `false`. Блок без единого `true` при сохранении удаляется (нормализация).
- Пароль на открытие в `pdf_options` не хранится: колонка `templates.pdf_password_enc text` (миграция 0009), `null` — пароля нет; значение — `encryptSecret(password, config.encryptionKey)` (как пароли источников данных).
- Защита включена, если задан пароль или хотя бы один из `noPrint`, `noCopy`, `noModify` равен `true`.
- `TemplateAdminDetails` получает `pdfPasswordSet: boolean`; сам пароль API не возвращает никогда (ни в DTO, ни в логах, ни в ошибках).
- `PUT /api/templates/:id/pdf-options` принимает необязательное поле `password`: поле отсутствует — пароль не меняется; строка — новый пароль (4–64 символа, проверка длины по символам; без управляющих символов, в том числе перевода строки — «пароль содержит недопустимые символы»; не начинается с «-» (qpdf 11.3 принимает такой пароль за ключ) — «пароль не может начинаться с «-»»; пробелы по краям не обрезаются); `null` — пароль снимается. Поле не входит в `PdfOptions`: тело запроса — `PdfOptions` плюс `password`.
- Правило PDF/A: `pdfa: true` вместе с защитой (с учётом пароля, который уже сохранён и не меняется в запросе) — `400 VALIDATION` «PDF/A несовместим с паролем и ограничениями». Проверка — в той же транзакции с блокировкой строки шаблона, что и правило приложений (§36.3).
- Приложенные файлы (§36.3) не меняются: шифруется итоговый документ целиком; зашифрованные приложения по-прежнему не принимаются.

### 37.2 Шифрование
- Последний шаг `finishPdf` (§36.4): после обработки `pdf-lib` (или сразу после конвертации, если обработки нет) при включённой защите вызывается `protectPdf(pdf, { userPassword, noPrint, noCopy, noModify }, timeoutMs)`; без защиты `qpdf` не вызывается и результат прежний.
- `qpdf` запускается через `execFile` (без shell) (в bookworm — qpdf 11.3, синтаксис `--user-password=` в нём нет) с аргументами `in.pdf --encrypt <user> <owner> 256 [--print=none] [--extract=n] [--modify=none] -- out.pdf`:
  - `user` — пароль на открытие; без пароля — пустой аргумент (документ открывается без пароля);
  - `owner` — каждый раз случайный (32 байта `randomBytes`, hex: в base64url бывает ведущий «-»), нигде не хранится;
  - AES-256 (R6); другие уровни не используются.
- Пароли не попадают в командную строку: аргументы пишутся в файл и передаются как `qpdf @args`. Входной, выходной файлы и файл аргументов — во временном каталоге `mkdtemp` с правами `0700` (файлы `0600`); каталог удаляется в `finally` при любом исходе.
- Процесс ограничен оставшимся сроком отчёта (`deadline`); по истечении — `SIGKILL` и ошибка срока как у рендера. Одновременных вызовов — не больше размера пула рендера (очередь, как у пула).
- Лимит 100 МБ (§36.4) проверяется после шифрования.
- Где действует: формирование отчёта (`out.pdf` снимка записывается уже зашифрованным) и скачивание PDF. Предпросмотр администратора не шифруется. Прочие форматы — без защиты.
- Прошлые запуски: `out.pdf` снимка уже зашифрован на момент запуска, поэтому смена пароля или ограничений не меняет PDF прошлых запусков (как §36.4). В `pdf-options.json` снимка пишутся `protection` и `passwordSet: boolean`, без пароля.
- Ошибки:
  - `qpdf` не найден — `503` «шифрование PDF недоступно: не установлен qpdf»; при старте API проверяет `qpdf --version` и при отсутствии пишет предупреждение в лог;
  - `qpdf` завершился с ошибкой (код, отличный от 0 и 3 — предупреждения) — `502` «не удалось зашифровать PDF», подробности (stderr без паролей) — в лог;
  - незащищённый PDF при включённой защите не выдаётся никогда.

### 37.3 Вкладка «PDF»
- Блок «Защита» — после «Метаданные», перед «Приложенные файлы»:
  - «Пароль на открытие»: если пароль не задан — поле ввода (скрытое, с кнопкой «показать»); если задан — текст «Пароль задан» и кнопки «Сменить» (показывает поле) и «Убрать». Пустое поле при сохранении — пароль не меняется;
  - флажки «Запретить печать», «Запретить копирование текста», «Запретить изменение»;
  - пояснение: «Запреты выполняют программы просмотра PDF; это не криптографическая защита. Без пароля на открытие документ откроет любой.»;
  - «Защита применяется к сформированным отчётам; предпросмотр показывается без неё.»
- При включённом PDF/A блок «Защита» неактивен с пояснением «Недоступно при PDF/A»; при включённой защите неактивен переключатель PDF/A с пояснением «Недоступно при пароле или запретах». Сервер проверяет правило сам (§37.1).
- Сохранение — общей кнопкой вкладки, ошибки у полей (как §36.5).

### 37.4 Перенос шаблонов
- `pdfOptions.protection` переносится как есть. Пароль не переносится; `TransferTemplate` получает необязательный `pdfPasswordSet: boolean`.
- Импорт: созданный шаблон — без пароля; обновлённый (`update`) — пароль цели сохраняется, если в архиве `pdfPasswordSet: true`, иначе снимается. `ImportPreviewItem` получает `pdfPasswordSet: boolean` (в архиве пароль был; действие на шаге предпросмотра ещё не выбрано); интерфейс показывает у такого шаблона предупреждение «Пароль PDF не переносится: новый шаблон будет без пароля, при обновлении останется пароль текущего шаблона».
- Копия шаблона («Дублировать», §36 R7) копирует и `pdf_password_enc`: это та же среда.
- Правило PDF/A (§37.1) проверяется при разборе архива, как правило PDF/A для приложений (§36.6): нарушение — архив не принимается (`pdfOptions.pdfa` «PDF/A несовместим с паролем и ограничениями»). В архив `pdfPasswordSet: true` пишется только у шаблона с паролем.

### 37.5 Образ, справка, тесты, выпуск
- Образы API (`prod` и `dev`): пакет `qpdf` из Debian bookworm (`apt-get install --no-install-recommends qpdf`); NOTICE — qpdf (Apache-2.0). CI: `qpdf` ставится на runner для модульных и интеграционных тестов. Локально тесты шифрования пропускаются без `qpdf` в `PATH` (в CI — обязательны: переменная `REQUIRE_QPDF=1`).
- Справка по шаблонам — подраздел «Пароль и ограничения» в разделе про PDF; README; CHANGELOG 2.7.1.
- Тесты:
  - `packages/shared`: схема `protection`, нормализация, длина пароля;
  - `apps/api` модульные (`qpdf`): без пароля документ не открывается (`unpdf` — ошибка пароля), с паролем — текст извлекается; `qpdf --show-encryption` — AES-256 и выбранные запреты; одни запреты — открывается без пароля; временный каталог удалён после успеха и ошибки; истечение срока убивает процесс; пароль не появляется в аргументах процесса; отсутствие `qpdf` — `503`;
  - API: пароль хранится зашифрованным и не возвращается, `pdfPasswordSet`, три значения поля `password`, правило PDF/A в обе стороны, отчёт и скачивание зашифрованы, предпросмотр — нет, PDF прошлого запуска не меняется после смены пароля, перенос (`protection`, `pdfPasswordSet` в архиве и в предпросмотре, сохранение пароля при `update`, копия шаблона с паролем);
  - web: состояния поля пароля, неактивность блока и переключателя PDF/A, ошибки.
- Ветка `feat/2.7.1` от `main` (2.7.0); слияние и тег `v2.7.1` — с разрешения владельца.

## 38. 2.8.0: редактор шаблона — один редактор, развёрнутый режим, перетаскивание тегов

Решения владельца 2026-10-15: электронная подпись (бывший 2.7.2) — в самом конце очереди; следующий выпуск — редактор шаблона (§30). Проверка 2026-10-15 на OnlyOffice 9.4 (бесплатная версия, без плагинов и коннектора) подтвердила перетаскивание: текст `text/plain`, перетащенный со страницы приложения в редактор (тот же источник `https://…`), вставляется в место отпускания — в DOCX целым тегом (отчёт подставил значение), в XLSX — в ячейку под указателем; владелец проверил вручную. Решения: блокировка с продлением раз в ~20 с, снятие через 60 с без продления, перехват с подтверждением (вариант A); хранение блокировки — в Postgres; развёрнутый режим — поверх приложения, не полноэкранный режим браузера (вариант A); панель тегов — перетаскивание, поиск, сворачивание и раздел «Конструкции» (вариант B).

### 38.1 Блокировка редактирования
- Таблица `template_edit_locks` (миграция 0010): `template_id uuid` — первичный ключ, ссылка на `templates` с `on delete cascade`; `user_id uuid not null` — ссылка на `users` с `on delete cascade`; `holder text not null` — номер вкладки (случайный UUID, создаётся браузером при открытии страницы шаблона; действует, пока страница открыта); `acquired_at`, `heartbeat_at timestamptz not null`.
- Блокировка действует, пока `heartbeat_at > now() - interval '60 seconds'`. Время — только часы базы (`now()`), не API. Просроченные строки не удаляются отдельно: их перезаписывает следующий захват; везде, где блокировка показывается или проверяется, просроченная считается отсутствующей.
- Состояние блокировки для вкладки (`EditLockState`, `packages/shared`):
  - `{ state: 'mine' }` — блокировка у этой вкладки;
  - `{ state: 'other', user: { id, login }, since, sameUser: boolean }` — у другой вкладки (`sameUser` — та же учётная запись);
  - `{ state: 'free' }` — блокировки нет (только в ответе без захвата, см. ниже).
- Маршруты (администратор, `holder` — UUID, иначе `400`):
  - `POST /api/templates/:id/edit-lock` `{ holder, acquire: boolean }` — при `acquire: true` захват или продление одним запросом `insert … on conflict (template_id) do update … where` (блокировка просрочена, или `holder` тот же) с `returning`: строка вернулась — `mine`, иначе читается действующая блокировка — `other`. При `acquire: false` (вкладка в просмотре) — только чтение: `other` или `free`; если блокировка у этого же `holder` — она продлевается и ответ `mine`.
  - `POST /api/templates/:id/edit-lock/takeover` `{ holder }` — блокировка переходит к этой вкладке безусловно (`acquired_at` и `heartbeat_at` — `now()`), ответ `mine`. Если до перехвата блокировка была у другой вкладки и действовала — после фиксации вызывается `forcesave` текущего ключа документа (как «Сохранить», §22.7); ответ `NO_CHANGES` и ошибки `forcesave` не влияют на ответ перехвата и пишутся в журнал на уровне `warn` (правки остаются в общей сессии документа и видны новому редактору).
  - `DELETE /api/templates/:id/edit-lock?holder=` — снимает блокировку, только если она у этого `holder`; иначе ничего не делает; всегда `204`. Браузер вызывает его при уходе со страницы шаблона и при закрытии вкладки браузера (`fetch` с `keepalive: true`; сессия — cookie, поэтому `sendBeacon` не нужен).
- Шаблон не найден — `404`, как у прочих маршрутов шаблона. В режиме обслуживания маршруты отвечают как все запросы API (`503 MAINTENANCE`).
- Права: только администратор (как редактор). Удаление пользователя или шаблона удаляет блокировку (`cascade`).

### 38.2 Где блокировка обязательна
- `GET /api/templates/:id/editor-config?holder=` — `holder` обязателен. Если блокировка у этого `holder` (действует) — конфиг правки, как сейчас (§22). Иначе — конфиг просмотра: `document.permissions.edit: false`, `editorConfig.mode: 'view'`; ключ документа, адрес файла и callback — те же. Сам конфиг блокировку не захватывает.
- Требуют, чтобы действующей блокировки у другой вкладки не было (иначе `409 TEMPLATE_LOCKED` «шаблон редактирует <логин>»):
  - `POST /api/templates/:id/save` — кроме того, нужен `holder` в теле, и блокировка должна быть у него (иначе тот же `409`; без действующей блокировки вообще — `409` «начните редактирование»);
  - `PUT /api/templates/:id/file` (замена файла в «Настройках») принимает необязательный `?holder=` (UUID, иначе `400`) — номер вкладки «Документ» той же страницы шаблона. Замена отклоняется (`409 TEMPLATE_LOCKED`), если действующая блокировка принадлежит другому `holder` или `holder` не передан; если блокировка у переданного `holder` — замена разрешена (страница, держащая блокировку, может заменить файл). После замены редактор перечитывает конфиг с новым ключом документа;
  - `DELETE /api/templates/:id` — отклоняется при любой действующей блокировке, в том числе своей вкладки (`409 TEMPLATE_LOCKED`): закройте редактор и повторите;
  - импорт архива (§33), действие `update`: в предпросмотре `ImportExisting` (кандидат на обновление) получает `lockedBy: { login } | null` — кандидатов может быть несколько, блокировка у конкретного, интерфейс показывает предупреждение «Шаблон редактирует <логин>: обновление будет отклонено, пока редактор открыт»; при загрузке действующая блокировка обновляемого шаблона — `409`, как прочие конфликты архива («шаблон «<имя>» редактирует <логин> — повторите позже»).
- Проверки выполняются в транзакции, где строка шаблона блокируется (`for update`), чтобы захват не проскочил между проверкой и изменением. Callback OnlyOffice (§22) блокировку не проверяет: сохранение после закрытия редактора проходит как сейчас.
- Остальные операции (запросы, параметры, графики, PDF, доступ, «Дублировать», выгрузка) блокировку не учитывают: они не трогают документ в OnlyOffice.

### 38.3 Вкладка «Документ»
- Блокировка принадлежит странице шаблона, а не вкладке «Документ»: `holder` создаётся при открытии страницы (новый на каждое открытие), захват (`edit-lock` с `acquire: true`) — при первом посещении «Документа»; переход на другие вкладки той же страницы блокировку не снимает. Затем конфиг редактора с этим `holder`.
- Продление — каждые 20 с: в правке `acquire: true`, в просмотре `acquire: false`; пока первого ответа нет — `acquire: true`. При возврате на вкладку браузера (`visibilitychange` → `visible`) продление выполняется сразу: фоновые вкладки браузер будит редко, и блокировка могла истечь.
- Ответ на запрос, отправленный раньше уже применённого (например, продление, ушедшее до перехвата), отбрасывается.
- Состояния (строка над редактором):
  - правка: «Вы редактируете»;
  - просмотр, чужая блокировка: «Только просмотр — редактирует <логин> с ЧЧ:ММ» и кнопка «Забрать редактирование» с подтверждением «Шаблон сейчас редактирует <логин>. Забрать редактирование? Сделанные правки будут сохранены, а у <логин> редактор переключится в просмотр»;
  - просмотр, своя другая вкладка (`sameUser`): «Шаблон открыт у вас в другой вкладке» и кнопка «Редактировать здесь» (тот же перехват без подтверждения);
  - просмотр, блокировка освободилась: «Документ свободен» и кнопка «Начать редактирование» (захват, затем редактор пересоздаётся в правке). Сам режим правки не включается: документ не перезагружается без действия сотрудника;
  - правка потеряна (продление вернуло `other`): редактор пересоздаётся в просмотре, сообщение «Редактирование забрал <логин>».
- Кнопка «Сохранить» — только в правке. Перетаскивание из панели тегов — только в правке; копирование — всегда.
- Ошибки продления: три подряд — предупреждение «Связь с сервером потеряна, изменения могут не сохраниться»; редактор не пересоздаётся. Первое успешное продление снимает предупреждение; если ответ `other` — переход в просмотр, как выше.
- Уход со страницы шаблона или закрытие вкладки браузера (`pagehide`) — `DELETE edit-lock`.
- Список шаблонов администратора: у шаблона с действующей блокировкой — метка «Редактирует <логин>» (`TemplateSummary` получает `editingBy: { login } | null`; не администратору — всегда `null`).
- Просмотр и правки на лету: первый шаг плана — проверка на стеке, видит ли вкладка в просмотре правки редактора без перезагрузки (та же сессия документа). Проверено 2026-10-15: просмотр показывает правки редактора на лету, кнопка «Обновить» не нужна.

### 38.4 Развёрнутый режим
- Кнопка «Развернуть» на вкладке «Документ». Развёрнутый режим — класс на контейнере вкладки: `position: fixed; inset: 0`, поверх приложения (выше бокового меню и всплывающих окон приложения, ниже уведомлений и диалогов). Редактор не переносится в другой узел DOM и не пересоздаётся (перенос `iframe` перезагружает OnlyOffice).
- Верхняя полоса: название шаблона, строка состояния (§38.3) с кнопками; справа «Сохранить», «Теги» (скрыть/показать панель), «Свернуть». Редактор и панель тегов занимают остальную высоту.
- Состояние — в адресе: `?tab=document&full=1`; при переключении вкладки шаблона или уходе со страницы режим снимается.
- Esc внутри редактора приложению не виден; выход — кнопкой «Свернуть» (и Esc, если фокус вне редактора).

### 38.5 Панель тегов
- Та же панель в обычном и развёрнутом режиме; ширина 320 px.
- Поиск: поле вверху, фильтр без учёта регистра по подписи узла и пути тега; совпавшие узлы показываются вместе с родителями (родители раскрыты); пустой результат — «Ничего не найдено».
- Сворачивание: у узла с детьми — стрелка. По умолчанию раскрыт первый уровень, глубже — свёрнуто; при поиске раскрыто всё найденное, и стрелки на это время скрыты.
- Плитка тега: `draggable` в правке; при перетаскивании — `dataTransfer.setData('text/plain', <тег>)`, `effectAllowed = 'copy'`; подсказка «Перетащите в документ или скопируйте». Кнопка «Скопировать» остаётся. Строки цикла (`[i]` и `[i+1]`) перетаскиваются по отдельности.
- Раздел «Конструкции» — над деревом, свёрнут по умолчанию; группы «Условия», «Формат», «Таблицы». Фрагмент — однострочный текст, где поле обозначено `поле`, массив — `массив`, значение — `значение`; перетаскивается и копируется как тег; ссылка «Подробнее» открывает справку на исходном примере в новой вкладке (`/admin/help#<id примера>`).
- Каждый фрагмент описан как `{ helpId, title, source, replace }`: `source` — один тег `{…}` из `template` примера справки `helpId` (подстрока; многострочные примеры и строки таблиц допустимы — берётся тег, не строка), `replace` — пары «имя в примере → обозначение» (например `d.cars → d.массив`, `brand → поле`); текст фрагмента — `source` после замен. Тест сверяет: пример `helpId` существует, `source` — подстрока его `template`, `source` — ровно один тег, после замен в тексте не осталось имён данных примера из `replace`. Так фрагменты остаются проверенными (`pnpm help:check` проверяет примеры справки).
- Набор фрагментов: «Условия» — текст по условию (`cond-if`), начало и конец скрытого блока (`cond-paragraphs`: `…:hideBegin`, `…:hideEnd`); «Формат» — дата цифрами (`fmt-date-short`), число (`fmt-number`), сумма в рублях (`fmt-money`); «Таблицы» — строка цикла и следующая строка (`tables-rows`), номер строки (`tables-numbering`), сумма по массиву (`agg-sum`). Если пример справки изменится так, что тега в нём нет, — тест падает, и фрагмент правится вместе со справкой.

### 38.6 Справка, тесты, выпуск
- README — раздел о редакторе (блокировка, перехват, развёрнутый режим, перетаскивание); справка по шаблонам — абзац о перетаскивании и «Конструкциях» во вводном разделе; CHANGELOG 2.8.0.
- Тесты:
  - `packages/shared`: схемы `EditLockState`, тела `edit-lock`;
  - API (интеграционные, Postgres в testcontainers): захват, продление, освобождение; чужая и просроченная блокировка; `acquire: false`; перехват (в том числе `forcesave` вызывается только при действовавшей чужой блокировке и его ошибка не влияет на ответ); гонка двух одновременных захватов — ровно один `mine`; режим в конфиге редактора; `409` для сохранения (чужая и отсутствующая блокировка), замены файла, удаления, импорта `update`; `lockedBy` в предпросмотре импорта; `editingBy` в списке; каскадное удаление;
  - web: состояния вкладки «Документ», переход в просмотр после перехвата, «Документ свободен», предупреждение о связи, `DELETE` при уходе, развёрнутый режим без пересоздания редактора (тот же экземпляр), поиск и сворачивание, данные перетаскивания, недоступность перетаскивания в просмотре, «Конструкции» сверены со справкой;
  - e2e (Playwright на стеке, вне CI): два администратора в двух контекстах браузера — второй видит «Редактирует», забирает правку, у первого — просмотр; перетаскивание тега из панели в DOCX и сборка отчёта с подставленным значением. Второму администратору e2e создаёт учётную запись через API и удаляет её после прогона.
- Ветка `feat/2.8.0` от `main` (2.7.1); слияние и тег `v2.8.0` — с разрешения владельца.

### 38.7 2.8.1: исправления редактора

Решение владельца 2026-10-16: выпуск исправлений после 2.8.0 без новых возможностей.
- Принудительная пересборка редактора (§38.3: редактор построен по устаревшему режиму) передаёт библиотеке незначимый `document_title`; название фиксируется в момент пересборки, поэтому переименование шаблона редактор не пересоздаёт.
- `@onlyoffice/document-editor-react` закреплён точной версией `2.2.0`: смена режима опирается на то, что библиотека пересоздаёт редактор при изменении содержимого конфига. Обновление — только с прогоном e2e `editor-lock`.
- Блокировка: устаревшие ответы отбрасываются, продление при возврате на вкладку браузера (§38.3).
- Панель тегов: стрелки сворачивания скрыты во время поиска (§38.5).
- Esc в окне «Забрать редактирование» закрывает только окно (окно останавливает Esc), развёрнутый режим остаётся — закреплено тестом.
- Код ответа при импорте занятого шаблона остаётся общим для конфликтов архива (§38.2).
- Ветка `feat/2.8.1` от `main` (2.8.0); слияние и тег `v2.8.1` — с разрешения владельца.

## 39. 2.9.0: электронная подпись PDF

Последний из PDF-выпусков (§36, бывший 2.7.2; очередь §38). Решения владельца 2026-10-19:
- вид подписи — вариант C: в 2.9.0 обычная подпись PDF (PAdES) по сертификату из `.p12` — по 63-ФЗ это усиленная неквалифицированная подпись; квалифицированная подпись по ГОСТ через КриптоПро (CSP или DSS, лицензирует заказчик) — отдельным выпуском позже, через точку расширения `CmsSigner` (§39.4);
- сертификат — у каждого пользователя свой (вариант C), отчёт подписывает тот, кто его сформировал;
- пароль к ключу вводится при каждой подписи и нигде не хранится (вариант A);
- шаблон разрешает подпись, пользователь решает, подписывать ли отчёт (вариант A);
- подпись несовместима с паролем и запретами §37 (вариант A);
- видимый штамп на последней странице (вариант A);
- метка времени — необязательная настройка системы (вариант A);
- реализация — библиотеки в API на JS: `pdf-lib`, `pkijs`/`asn1js`, `node-forge` для чтения `.p12` (вариант 1; pyHanko в образе и отдельный сервис на Java с EU DSS отвергнуты как тяжёлые).

Эталона EE нет, код образа EE не читается.

### 39.1 Сертификат пользователя
- Страница «Моя подпись» (`/signature`) — пункт в меню пользователя, для всех ролей, в том числе для пользователей LDAP.
  - Без сертификата — кнопка «Загрузить сертификат» и пояснение «Нужен файл .p12 или .pfx с закрытым ключом — его выдаёт удостоверяющий центр или ИТ-служба».
  - С сертификатом — карточка: владелец (CN), издатель, серийный номер, срок действия, отпечаток SHA-256; кнопки «Заменить» и «Удалить» (с подтверждением). До окончания срока меньше 30 дней — предупреждение «Срок действия сертификата заканчивается ДД.ММ.ГГГГ»; срок истёк — ошибка «Срок действия сертификата истёк — загрузите новый».
- `POST /api/me/certificate` (multipart: файл и поле `password`) — загрузка или замена; `201` с `CertificateInfo`. Пароль используется только для проверки и чтения сведений и не сохраняется.
- Проверки при загрузке (`400 VALIDATION`, сообщение у поля):
  - файл до 50 КБ; открывается `node-forge` этим паролем, иначе «неверный пароль или повреждённый файл»; поддерживаются `.p12` OpenSSL 3 (PBES2/AES) и старые (`-legacy`, 3DES/RC2);
  - внутри ровно один закрытый ключ и сертификат с тем же открытым ключом, иначе «в файле должен быть один ключ и его сертификат»;
  - ключ RSA от 2048 бит или ECDSA P-256/P-384, иначе «алгоритм ключа не поддерживается»; ключ ГОСТ (OID семейства 1.2.643) — «ГОСТ-сертификаты подписываются через КриптоПро — пока не поддерживается»;
  - сертификат действует на момент загрузки (`notBefore ≤ now ≤ notAfter`), иначе «сертификат ещё не действует» или «срок действия сертификата истёк»;
  - если есть расширение `keyUsage`, в нём есть `digitalSignature` или `nonRepudiation`, иначе «сертификат не предназначен для подписи»;
  - прочие сертификаты из файла (цепочка) сохраняются и вкладываются в подпись; цепочка до доверенного корня не проверяется (доверие решает проверяющий).
- `GET /api/me/certificate` — `CertificateInfo | null`; `DELETE /api/me/certificate` — `204`.
- `CertificateInfo` (`packages/shared`): `{ subjectCn, issuer, serial, notBefore, notAfter, fingerprint, keyAlg }`; `serial` и `fingerprint` — hex в верхнем регистре, `fingerprint` — SHA-256 сертификата; `issuer` — CN издателя, без CN — вся строка DN.
- Хранение — таблица `user_certificates` (миграция 0011): `user_id uuid` — первичный ключ, ссылка на `users` с `on delete cascade` (один сертификат на пользователя); `p12_enc text not null` — `encryptSecret(base64(файл), config.encryptionKey)`; `subject_cn`, `issuer`, `serial`, `fingerprint`, `key_alg text not null`; `not_before`, `not_after timestamptz not null`; `created_at`.
- Файл `.p12` API не отдаёт никому, включая владельца.
- Администратор: в списке пользователей колонка «Подпись» — «до ДД.ММ.ГГГГ» (красным — истёк) или «—»; `UserDto` получает `certificateNotAfter: string | null`. `DELETE /api/users/:id/certificate` (администратор) — удаляет сертификат пользователя, `204`; в диалоге пользователя — кнопка «Удалить сертификат подписи» с подтверждением. Загрузить или скачать чужой сертификат администратор не может.

### 39.2 Настройка шаблона
- `PdfOptions` (§36.1) получает необязательный блок `signature` — `{ position }`, `position` — `bottom-left|bottom-center|bottom-right`, по умолчанию `bottom-right`. Блок есть — подпись разрешена.
- Правило: `signature` вместе с защитой §37 (с учётом сохранённого пароля, как §37.1) — `400 VALIDATION` «Подпись несовместима с паролем и ограничениями» (у поля `signature`). Проверка — в той же транзакции с блокировкой строки шаблона, что правила PDF/A. С PDF/A подпись совместима.
- Вкладка «PDF» — блок «Электронная подпись» после «Защита»: флажок «Разрешить подпись PDF», положение штампа («внизу слева», «по центру», «справа»), пояснения «Отчёт подписывает пользователь своим сертификатом после формирования» и «Штамп ставится поверх последней страницы — оставьте внизу последней страницы 110 пт». При включённой защите блок неактивен с пояснением «Недоступно при пароле или запретах»; при включённой подписи неактивен блок «Защита» с пояснением «Недоступно при электронной подписи». Сохранение — общей кнопкой вкладки.
- Перенос шаблонов: `pdfOptions.signature` переносится как есть; правило проверяется при разборе архива, как правило PDF/A (§37.4). Копия шаблона копирует блок.
- `pdf-options.json` снимка запуска содержит `signature` — по нему решается, можно ли подписать запуск. Изменение настройки шаблона не меняет прошлые запуски (в обе стороны).

### 39.3 Подпись отчёта
- `POST /api/runs/:id/sign` `{ password }` (`password` — строка 1–256 символов):
  - запуск не найден или не свой — `404` (администратор чужой запуск не подписывает);
  - запуск без снимка, со статусом `error`, с удалённым файлом или без `signature` в снимке — `400` «подпись для этого отчёта недоступна»;
  - нет сертификата — `400` «загрузите сертификат на странице «Моя подпись»»; сертификат истёк или ещё не действует — `400` «срок действия сертификата истёк» / «сертификат ещё не действует»;
  - неверный пароль — `400` «неверный пароль к ключу»; неверных попыток не больше 5 за 15 минут на пользователя (с 2.9.1 — счётчик в Postgres, §39.8; в 2.9.0 — хранилище лимитов Redis §21), дальше — `429` «слишком много неверных паролей — попробуйте через 15 минут»; верный пароль счётчик не сбрасывает;
  - запуск уже подписан — `409` «отчёт уже подписан»; одновременные запросы — блокировка запуска как у сборки форматов (§24.2), второй получает `409` после первого, а при неудаче первого — подписывает сам (с 2.9.1 второй запрос того же пользователя сразу получает `409 SIGN_BUSY`, §39.8);
  - успех — `201` с `RunSignature`.
- Подписывается `reports/<runId>/out.pdf` (уже с обработкой §36.4); результат — `reports/<runId>/out.signed.pdf`. Срок — `REPORT_TIMEOUT_MS` от начала запроса; работа — в пуле рендера. Результат больше 100 МБ — `400`, как §36.4.
- Таблица `report_run_signatures` (миграция 0011): `run_id uuid` — первичный ключ, ссылка на `report_runs` с `on delete cascade`; `user_id uuid not null` (ссылка на `users`, `cascade`); `signer_cn text`, `fingerprint text`, `signed_at timestamptz`, `timestamped boolean`, `file_path text` — все `not null`. Строка пишется после записи файла; при ошибке записи строки файл удаляется.
- `RunSignature` (`packages/shared`): `{ signerCn, fingerprint, signedAt, timestamped }`.
- `GET /api/runs/:id/file?format=pdf&signed=1[&inline=…]` — подписанный PDF (владелец или администратор, как §24.4); запуск не подписан — `404`; `signed=1` с другим форматом — `400`. Имя файла — как у PDF запуска с суффиксом `-signed`.
- `GET /api/runs` — у запуска `signature: RunSignature | null` и `signable: boolean` (снимок, `ok`, файл не удалён, `signature` в снимке, ещё не подписан; наличие сертификата не учитывается — его проверяет интерфейс).
- Очистка по `REPORT_RETENTION_DAYS` удаляет каталог (с `out.signed.pdf`) и строку подписи; удаление пользователя — тоже.
- Интерфейс:
  - ReportRunPage: при `signable` — кнопка «Подписать PDF» рядом с «Сохранить как». Без сертификата кнопка неактивна с подсказкой «Загрузите сертификат на странице «Моя подпись»» (ссылка). Диалог: поле «Пароль к ключу подписи» (скрытое), владелец и срок сертификата, кнопка «Подписать»; ошибки — в диалоге. После подписи — строка «Подписан: <CN>, ДД.ММ.ГГГГ ЧЧ:ММ» и кнопка «Скачать подписанный PDF»;
  - HistoryPage: у подписанного запуска — значок с подсказкой «Подписан: <CN>, …»; в меню «Скачать» — «PDF с подписью»; при `signable` — пункт «Подписать…» с тем же диалогом.

### 39.4 Формат подписи
- Модуль `apps/api/src/modules/pdf/sign/`. Шаги:
  1. `p12_enc` расшифровывается `ENCRYPTION_KEY`, `.p12` открывается паролем; ключ — только в памяти вызова, не пишется и не логируется. `password` добавляется в скрываемые поля логов Fastify (`redact`).
  2. `pdf-lib` готовит документ: на последней странице поле подписи (`/FT /Sig`, виджет `/F 4`, `AcroForm /SigFlags 3`) с внешним видом `/AP /N` — штамп (§39.5); словарь подписи `/Type /Sig /Filter /Adobe.PPKLite /SubFilter /ETSI.CAdES.detached /M (время подписи) /ByteRange /Contents <0…>`. Размер `/Contents` — `2 × (сумма DER сертификатов + 12 288)` шестнадцатеричных знаков. Сохранение — целиком, `useObjectStreams: false`, `updateMetadata: false` (Info и XMP не меняются; OutputIntent и `/ID` сохраняются — PDF/A-2b остаётся действительным).
  3. `ByteRange` — весь файл, кроме значения `/Contents`; SHA-256 по двум диапазонам.
  4. `pkijs` собирает CMS `SignedData` (PAdES baseline B-B): `eContent` отсутствует (detached); подписанные атрибуты — `contentType` (`id-data`), `messageDigest`, `signing-certificate-v2` (SHA-256 сертификата подписанта); `signingTime` нет. Алгоритм — RSA PKCS#1 v1.5 с SHA-256; ECDSA P-256 — с SHA-256, P-384 — с SHA-384 (хэш документа — тем же алгоритмом). В `certificates` — сертификат подписанта и цепочка из `.p12`.
  5. Если задан `SIGN_TSA_URL` — метка времени RFC 3161 (B-T): `POST` `application/timestamp-query` с хэшем `signatureValue`, `nonce` (64 бита случайно), `certReq: true`; таймаут — меньшее из `SIGN_TSA_TIMEOUT_MS` и оставшегося срока. Ответ проверяется: статус `granted`/`grantedWithMods`, `messageImprint` и `nonce` совпадают. Токен — неподписанный атрибут `id-aa-signatureTimeStampToken`.
  6. DER CMS записывается в `/Contents`; не помещается — внутренняя ошибка `500` (ловится тестами).
- Точка расширения: `interface CmsSigner { readonly info: CertificateInfo; readonly digestAlg: 'SHA-256' | 'SHA-384'; createCms(digest: Uint8Array, deadline: number): Promise<Uint8Array> }`. В 2.9.0 — реализация `P12Signer`; подготовка PDF, штамп и метка времени от неё не зависят (метку добавляет `P12Signer` через общую функцию `addTimestamp`).
- Ошибки: служба меток недоступна, ответила ошибкой или неверным ответом — `502` «служба меток времени недоступна», подпись не сохраняется (подробности — в лог); истёк срок — ошибка срока как у рендера. Пароль и ключ не попадают в ответы и логи.

### 39.5 Штамп
- Рамка 250 × 80 пт, линия 1 пт, цвет `#1F4E9A`, на белом фоне; отступ 24 пт от нижнего и бокового края видимой области (CropBox, иначе MediaBox) с учётом `/Rotate` (как нумерация, §36.4); `bottom-center` — по центру.
- Строки (Noto Sans из `packages/carbone/assets/fonts`, подмножеством; первая — Bold 8 пт, прочие — Regular 7 пт):
  - «ДОКУМЕНТ ПОДПИСАН ЭЛЕКТРОННОЙ ПОДПИСЬЮ»;
  - «Сертификат: <serial>»;
  - «Владелец: <CN>»;
  - «Действителен: с ДД.ММ.ГГГГ по ДД.ММ.ГГГГ»;
  - «Подписан: ДД.ММ.ГГГГ ЧЧ:ММ» — время сервера в часовом поясе `TZ`, то же, что `/M`.
- Строка длиннее рамки обрезается с «…»; символы вне шрифта — `?`, управляющие — пробел (как §36.2).
- Штамп ложится поверх содержимого; место оставляет автор шаблона (справка).

### 39.6 Настройка системы
- `SIGN_TSA_URL` — необязательный адрес службы меток (`http` или `https`, иначе API не стартует с понятной ошибкой); пусто — подпись без метки.
- `SIGN_TSA_TIMEOUT_MS` — по умолчанию `10000`, 1000–60000.
- compose (`.env.example`) и Helm values (ConfigMap); README — раздел «Электронная подпись».

### 39.7 Справка, образ, тесты, выпуск
- Зависимости API: `pkijs`, `asn1js`, `node-forge`; NOTICE — их лицензии (BSD-3-Clause; `node-forge` — по выбору BSD-3-Clause). pyHanko и veraPDF — только в CI.
- Справка по шаблонам — раздел «Электронная подпись»: какая это подпись (усиленная неквалифицированная, без ГОСТ), где действует, место под штамп, метка времени, проверка в Adobe Reader (сертификат УЦ должен быть доверенным у получателя).
- Тестовые сертификаты — `apps/api/test/fixtures/sign/make.sh` (OpenSSL): тестовый УЦ; RSA-2048 и ECDSA P-256; просроченный; с `keyUsage` без подписи; два ключа в одном файле; `.p12` OpenSSL 3 и `-legacy`; сертификат службы меток. Файлы с тестовым паролем лежат в репозитории. Тестовая служба меток — HTTP-обработчик на `pkijs` в тестах.
- Тесты:
  - первая задача плана — проверка риска: DOCX → OnlyOffice `pdfa` → `postprocessPdf` (водяной знак, нумерация) → подпись со штампом и меткой тестовой службы → `pyhanko sign validate` (доверие тестовому УЦ: подпись целая, цепочка доверенная, метка действительна) и veraPDF PDF/A-2B без нарушений; при провале — остановка и решение владельца;
  - `packages/shared`: схема `signature`, правило с защитой, `CertificateInfo`, `RunSignature`;
  - `apps/api` модульные: разбор `.p12` (оба формата, RSA и ECDSA, неверный пароль, два ключа, неподдерживаемый алгоритм, ГОСТ, истёкший, `keyUsage`); подготовка PDF (`ByteRange`, штамп в трёх положениях и на странице `/Rotate 90`, кириллица и замена символов, длинный CN, Info и XMP не меняются); CMS (проверка `pkijs` и `openssl cms -verify` по вырезанным байтам, атрибуты, цепочка); метка времени (есть; отказ, неверный `nonce`, таймаут — `502`); пароль не попадает в лог;
  - API: загрузка, замена, удаление сертификата, ошибки загрузки, `.p12` не отдаётся, удаление администратором; правило совместимости в обе стороны и при переносе; подпись — успех и скачивание `signed=1`, повтор и одновременные запросы (`409`), чужой запуск (`404`), снимок решает в обе стороны, лимит паролей (`429`), очистка удаляет подпись;
  - web: страница «Моя подпись» (все состояния, предупреждение о сроке), блок на вкладке «PDF» и взаимная неактивность с «Защита», диалог подписи и ошибки, кнопки на ReportRunPage и в истории, колонка в списке пользователей;
  - интеграционные (CI): подпись без метки и с меткой — pyHanko; PDF/A + подпись — veraPDF;
  - e2e: загрузить сертификат → сформировать отчёт → подписать → скачать подписанный PDF (демо-стек).
- CHANGELOG 2.9.0.
- Ветка `feat/2.9.0` от `main` (2.8.1); слияние и тег `v2.9.0` — с разрешения владельца.

### 39.8 2.9.1: доработки подписи

Остаточные риски 2.9.0, решения владельца 2026-10-20: разбор `.p12` — в потоке пула; вторая подпись того же пользователя не ждёт, а сразу получает `409` (вариант «сразу 409»); счётчик неверных паролей — в Postgres. Внешний вид, формат подписи и API, кроме перечисленного, не меняются.

**Разбор `.p12` в потоке пула рендера.**
- Новый вид задачи пула `kind: 'p12'` (рядом с `carbone`, `pdf`, `sign`). В поток уходят байты `.p12`, пароль и время проверки срока; поток вызывает `readP12` (лимиты итераций §39.1 те же) и возвращает ключ в DER PKCS#8 без шифрования, DER сертификата, DER цепочки, `CertificateInfo` и `digestAlg`. Основной поток делает из DER `KeyObject` (`createPrivateKey`) и сразу затирает буфер нулями. Ключ и пароль не пишутся в лог ни потоком, ни пулом.
- Ошибка разбора доходит до основного потока с полем: пул передаёт у ошибки задачи `field` (`file` или `password`), и `P12Error` восстанавливается с тем же полем и текстом. Прочие ошибки потока — как у других задач (внутренняя ошибка `500`).
- Через пул идут оба места: загрузка сертификата (`POST /api/me/certificate`) и подпись (`POST /api/runs/:id/sign`). Срок задачи — остаток `REPORT_TIMEOUT_MS` от начала запроса; истёк (в том числе в очереди за отчётами) — ошибка срока, как у рендера (`504`). Падение потока — как у рендера.
- Синхронная `readP12` в основном потоке API больше не вызывается (остаётся для потока и тестов).

**Подпись не ждёт другую подпись того же пользователя.**
- `runFileGate` получает режим «без ожидания»: вместо `pg_advisory_xact_lock` — `pg_try_advisory_xact_lock` с теми же классом и ключом. Блокировка занята — транзакция откатывается, соединение `runFilePool` сразу возвращается в пул, ответ — `409 SIGN_BUSY` «другая подпись уже выполняется — повторите через несколько секунд».
- Подпись использует только этот режим (ключ `sign:<userId>`); сборка форматов (§24.2) ждёт блокировку, как раньше.
- Повторная подпись того же запуска после завершения первой — по-прежнему `409` «отчёт уже подписан».
- Интерфейс: текст ошибки показывается в диалоге подписи, как другие ошибки; пароль в поле сохраняется.

**Счётчик неверных паролей — в Postgres.**
- Таблица `sign_password_failures` (миграция 0012): `user_id uuid` — первичный ключ, ссылка на `users` с `on delete cascade`; `count integer not null`; `window_start timestamptz not null`.
- Окно фиксированное: 15 минут от первой неверной попытки. Неверный пароль: если строки нет или окно закончилось (`window_start + 15 мин ≤ now`) — `count = 1`, `window_start = now`; иначе `count + 1`. Подпись запрещена, пока `count ≥ 5` и окно не закончилось — `429 TOO_MANY_ATTEMPTS` с прежним текстом. Верный пароль счётчик не сбрасывает (как в 2.9.0).
- Проверки: ранняя — до блокировки (основной пул, без ожидания блокировки), решающая — внутри блокировки пользователя, перед разбором `.p12`. Запись неверной попытки — в транзакции под блокировкой; чтобы она не откатилась, транзакция не завершается ошибкой, а возвращает результат «неверный пароль», и `400` «неверный пароль к ключу» отдаётся после фиксации.
- Счёт не зависит от Redis и одинаков для всех экземпляров API. `@fastify/rate-limit` для подписи больше не используется; лимит загрузок сертификата (10 в минуту на пользователя, §39.1) остаётся в хранилище лимитов Redis §21.
- Устаревшие строки не чистятся отдельно: строка одна на пользователя и перезаписывается при следующей ошибке.

**Тесты.**
- `apps/api` модульные: задача `p12` в пуле — успех (подпись ключом из потока проверяется), неверный пароль и повреждённый файл с полем ошибки, срок истёк в очереди; несколько ключей в файле, каждый до 100 000 итераций, вместе больше 300 000 — отказ по бюджету при разборе; `runFileGate` без ожидания — занятая блокировка даёт `SIGN_BUSY`, соединение возвращено в пул; счётчик — окно, сброс по окончании окна, 5 → `429`.
- API (интеграционные): две одновременные подписи одного пользователя — одна `201`, другая `409 SIGN_BUSY`; пять неверных паролей → `429` и строка в `sign_password_failures`; счётчик — строка в базе: записанная напрямую строка `count = 5` даёт `429`, после окончания окна неверный пароль начинает новое окно (`count = 1`); загрузка сертификата через пул (успех, неверный пароль).
- web: ошибка `SIGN_BUSY` в диалоге подписи, пароль не очищается.
- CHANGELOG 2.9.1, README (лимит паролей — в базе, вторая подпись — `409`). Ветка `feat/2.9.1` от `main` (2.9.0); слияние и тег `v2.9.1` — с разрешения владельца.

## 40. 2.10.0: вход через Keycloak (OpenID Connect)

Внешний PR #3 (автор — сторонний разработчик), принят владельцем 2026-10-20 после проверки безопасности и исправлений; подробное описание для администратора — `docs/operations/keycloak.md`, она и является спецификацией функции. Кратко:
- OIDC выключен по умолчанию (`OIDC_ENABLED=false`); кнопки на странице входа нет, вход — `/api/auth/oidc/login?next=…`. Authorization code + PKCE S256; state и nonce одноразовые (Redis, 10 минут) и привязаны к HttpOnly cookie; ID token — RS256 через JWKS, проверяются `iss`, `aud`, `azp`, `exp`, `nonce`.
- Пользователь — по паре `issuer` + `sub` (таблица `oidc_identities`); первый вход заводит пользователя с ролью `user` и `users.auth_source = 'oidc'`; совпадение логина с существующим аккаунтом — `409 OIDC_ACCOUNT_LINK_REQUIRED`, привязка — только администратором. `ADMIN_LOGIN` не привязывается и не открывается через OIDC. `preferred_username` — по правилам логина (3–64, trim), без управляющих, bidi и zero-width символов.
- Сессия приложения 12 часов, OIDC-сессия (`oidc_sessions`) проверяется на каждом запросе; завершается выходом, back-channel logout (600 в минуту с адреса; сбой JWKS — 503), блокировкой и отвязкой; истёкшие удаляются раз в час.
- LDAP: `LDAP_LOGIN_ATTRIBUTE` (необязательно) — канонический логин из записи, сопоставление без учёта регистра; не задан — прежнее поведение. `ADMIN_LOGIN` недоступен через LDAP в любом написании; аккаунт с `auth_source = 'oidc'` через LDAP не открывается.
- Миграция 0013: таблицы OIDC, `users.auth_source` (`local` по умолчанию), уникальный индекс `lower(login)`; при логинах, отличающихся только регистром, — остановка с их списком.
- Тесты: протокол против локального HTTPS IdP (модульные), маршруты и БД — `test/oidc.int.test.ts`, LDAP — настоящий OpenLDAP.
- Известное, не исправлено (низкий риск): повтор `jti` logout token не отсекается; ответы 409/403 callback раскрывают существование логина; при незаданном `LDAP_LOGIN_ATTRIBUTE` логин с пробелами по краям проходит LDAP и заводит отдельный аккаунт.

## 41. 2.10.1: остаточные риски входа и подписи

Решения владельца 2026-10-20: закрыть известные низкие риски 2.10.0 (§40) и отложенные замечания 2.9.1 (§39.8). Новых функций, миграций и изменений интерфейса нет; API меняется только в перечисленном.

**Повтор logout token.**
- После успешной проверки back-channel logout token `jti` запоминается в Redis: ключ `cr:oidc:logout-jti:<sha256(iss + "\n" + jti) в hex>`, `SET NX`, срок 10 минут (больше `maxTokenAge` 5 минут с запасом на расхождение часов).
- Ключ уже есть — токен повторный: сессии не завершаются, ответ `200` (как при первом приёме), в журнал — `info` «OIDC: повтор back-channel logout пропущен» без токена. Без Redis OIDC не работает (§40), отдельной ветки нет.

**Ответы callback не раскрывают логин.**
- Вход через Keycloak в `ADMIN_LOGIN` и совпадение логина с существующим непривязанным аккаунтом (в том числе при гонке заведения) отвечают одинаково: `403 OIDC_LOGIN_UNAVAILABLE` «вход через Keycloak для этой учётной записи недоступен — обратитесь к администратору». Коды `OIDC_ACCOUNT_RESERVED` и `OIDC_ACCOUNT_LINK_REQUIRED` не используются.
- Настоящая причина — в журнал `warn` с логином и `sub`, без токенов: «логин встроенного администратора» / «логин занят, нужна привязка администратором».
- Остальные ответы callback не меняются (`401 OIDC_INVALID_RESPONSE`, `403 OIDC_INVALID_USERNAME`, `401` для заблокированного пользователя).

**Логин при входе обрезается.**
- `LoginBody.login` — `trim()` до проверки длины (1–256). Действует для локального пароля и LDAP: ` fry ` входит как `fry`, отдельный аккаунт не заводится. Пароль не обрезается.

**Префиксы cookie.**
- При `COOKIE_SECURE=true` cookie сессии называется `__Host-session` (`Secure`, `Path=/`, без `Domain`), cookie потока OIDC — `__Secure-oidc_flow` (путь `/api/auth/oidc` не позволяет `__Host-`). При `COOKIE_SECURE=false` имена прежние (`session`, `oidc_flow`): браузер не принимает префиксные cookie без `Secure`.
- Имя выбирается одной функцией от конфигурации и используется везде: установка, чтение (guards, выход, `/api/auth/me`), удаление. Cookie со старым именем не читается — после обновления с `COOKIE_SECURE=true` каждому нужно войти заново один раз (в CHANGELOG, раздел «Обновление»). Старая cookie `session` при выходе тоже удаляется.

**Журнал запросов OIDC.**
- `logUrl` проверяет префикс `/api/auth/oidc/` по декодированному пути (`decodeURIComponent` части до `?`); путь не декодируется — query отбрасывается. Так `/api/auth/%6fidc/callback?code=…` не пишет код в журнал.

**Мелочи подписи (§39.8).**
- Ответ потока для задачи `p12` проверяется схемой (zod: `cert` — строка base64, `chain` — массив строк, `info` — объект `CertificateInfo`, `digestAlg` — из допустимых); несоответствие — внутренняя ошибка `500` с записью в журнал, ключ затирается так же, как при успехе.
- Загрузка сертификата: срок задачи пула отсчитывается от начала обработки запроса (до чтения тела multipart), как сказано в §39.8.
- Окно счётчика неверных паролей считается по часам Postgres: в проверке и записи вместо времени API — `now()` базы. Подпись и загрузка передают в `readP12` по-прежнему время API (срок действия сертификата).

**Тесты.**
- API (интеграционные): повтор того же logout token — `200`, сессия, заведённая после первого приёма, остаётся; callback с логином `ADMIN_LOGIN` и с занятым логином — одинаковый `403 OIDC_LOGIN_UNAVAILABLE`; вход ` fry ` (LDAP и локальный) — тот же аккаунт; `COOKIE_SECURE=true` — `Set-Cookie: __Host-session=…; Secure; Path=/`, запросы с ней авторизованы, с `session=` — `401`; загрузка сертификата через настоящий пул потоков (успех и неверный пароль); счётчик: окно по `now()` базы.
- `apps/api` модульные: `logUrl` с процент-кодированием и неверной кодировкой; некорректный `meta` от потока — ошибка, не `TypeError`.
- CHANGELOG 2.10.1 (включая повторный вход), README и `docs/operations/keycloak.md` (новый код ошибки, имена cookie). Ветка `feat/2.10.1` от `main`; PR, слияние и тег `v2.10.1` — с разрешения владельца.

## 42. 2.11.0: подпись по ГОСТ через КриптоПро ЭЦП Browser plug-in

Решения владельца 2026-10-20: ключ пользователя не покидает его компьютер (хранить ключи ГОСТ на сервере не пройдёт по требованиям безопасности); подпись — открепленная CAdES (`.sig`) рядом с PDF со штампом; способ подписи задаёт шаблон; сервер полностью проверяет подпись своей реализацией ГОСТ на TypeScript (подход A); метка времени — CAdES-T, если задан адрес службы; скачивание — двумя файлами. Образ `jrave/cryptopro` (CSP 4, PHP 5.6, 2017) не используется. Подпись `.p12` (§39) не меняется.

### 42.1 Шаблон и снимок
- `PdfOptions.signature` получает необязательное поле `method`: `'p12' | 'gost'`; нет поля — `'p12'` (шаблоны и запуски до 2.11.0 работают как раньше). Снимок запуска (`pdf-options.json`) содержит `method`; подписать запуск можно только способом из снимка.
- Правила совместимости (§39.2: с защитой §37 — нельзя, с PDF/A — можно), перенос шаблонов и копия — как у `signature`, поле переносится как есть; неизвестное значение — `400 VALIDATION` (при разборе архива — `IMPORT_INVALID`).
- Вкладка «PDF», блок «Электронная подпись»: выбор «Способ подписи» — «Сертификат .p12 (подпись в PDF)» / «ГОСТ, КриптоПро (файл .sig)»; у ГОСТ — пояснение «Пользователю нужны КриптоПро CSP, КриптоПро ЭЦП Browser plug-in и сертификат ГОСТ на своём компьютере». Положение штампа — общее для обоих способов.

### 42.2 Подписание
Шаги в браузере: выбор сертификата в плагине → подготовка на сервере → подпись хеша плагином → завершение на сервере. PDF в браузер не передаётся.

**`POST /api/runs/:id/sign/gost/prepare`** `{ certificate }` — DER сертификата в base64, до 16 КБ:
- запуск не найден или не свой — `404`; нельзя подписать (условия `signable` §39.3) или в снимке `method` не `'gost'` — `400` «подпись для этого отчёта недоступна»; уже подписан — `409` «отчёт уже подписан»;
- сертификат не разбирается — `400` «неверный сертификат»; ключ не ГОСТ Р 34.10-2012 (OID `1.2.643.7.1.1.1.1` — 256 бит, `1.2.643.7.1.1.1.2` — 512 бит) или набор параметров не из §42.4 — `400` «сертификат не ГОСТ Р 34.10-2012 или не поддерживается»; срок действия (по времени сервера) — `400` «срок действия сертификата истёк» / «сертификат ещё не действует»; `keyUsage` есть и без `digitalSignature` — `400` «сертификат не предназначен для подписи»;
- задача пула `gost-prepare`: штамп §42.3 на `reports/<runId>/out.pdf` → `reports/<runId>/out.gost.<uuid>.pdf` (черновик; путь уникален для каждой подготовки, чтобы неудавшееся завершение не связало старый хеш с новым черновиком), хеш Стрибог черновика — 256 бит для ключа 256, 512 бит для ключа 512;
- строка `gost_sign_pending` (§42.5) записывается или заменяется (повторная подготовка заменяет прежнюю и её черновик); срок ожидания — 15 минут;
- ответ `200` `{ hash, hashAlg, tsaUrl }`: `hash` — hex в порядке байтов, который принимает `CAdESCOM.HashedData.SetHashValue`; `hashAlg` — `'streebog256' | 'streebog512'`; `tsaUrl` — `SIGN_GOST_TSA_URL` или `null`.

**Браузер:** `CAdESCOM.HashedData` (алгоритм `CADESCOM_HASH_ALGORITHM_CP_GOST_3411_2012_256` / `_512`, `SetHashValue(hash)`) → `CAdESCOM.CadesSignedData.SignHash(hashedData, signer, CADESCOM_CADES_T | CADESCOM_CADES_BES)` с `signer.TSAAddress = tsaUrl`, если он задан; кодировка — base64. ПИН-код и пароль контейнера спрашивает сам плагин.

**`POST /api/runs/:id/sign/gost/complete`** `{ signature }` — base64, после декодирования до 64 КБ:
- `404`/`400`/`409` по запуску — как у подготовки; ожидания нет, оно другого пользователя или истекло — `409` «начните подписание заново» (истёкшее удаляется вместе с черновиком);
- задача пула `gost-verify` (§42.4); любой отказ — `400` с текстом причины (§42.4), черновик и ожидание остаются до истечения срока — можно повторить подпись;
- успех: черновик переименовывается в `out.signed.pdf`, DER подписи пишется в `out.signed.pdf.sig`, в одной транзакции — строка `report_run_signatures` (`method = 'gost'`, `signer_cn`, `fingerprint` — SHA-256 сертификата, `signed_at` — время метки, иначе время сервера при завершении, `timestamped`, `file_path`, `sig_path`) и удаление ожидания; при ошибке записи строки файлы удаляются. Ответ `201` `RunSignature`.
- Подготовка и завершение — под блокировкой пользователя без ожидания (`ifBusy`, §39.8): занята — `409 SIGN_BUSY`. Срок каждой задачи пула — `REPORT_TIMEOUT_MS` от начала запроса.
- `RunSignature` получает `method: 'p12' | 'gost'`.

### 42.3 Штамп
- Тот же штамп, что §39.5 (рамка, шрифт, положение из шаблона, обрезка, замена символов), но без поля и словаря подписи: только содержимое страницы, PDF сохраняется целиком, как §39.4 шаг 2 (Info, XMP, OutputIntent, `/ID` не меняются — PDF/A-2b остаётся действительным).
- Строки: «ДОКУМЕНТ ПОДПИСАН ЭЛЕКТРОННОЙ ПОДПИСЬЮ»; «Сертификат: <serial hex>»; «Владелец: <CN>»; «Действителен: с ДД.ММ.ГГГГ по ДД.ММ.ГГГГ»; «Подписан: ДД.ММ.ГГГГ ЧЧ:ММ» — время сервера при подготовке, в часовом поясе `TZ`.
- Результат больше 100 МБ — `400`, как §36.4.

### 42.4 Проверка подписи на сервере
Модули `apps/api/src/modules/pdf/sign/gost/`:
- `streebog.ts` — ГОСТ Р 34.11-2012, 256 и 512 бит, потоковый (хеш файла частями, без чтения целиком в память).
- `gost3410.ts` — только проверка подписи ГОСТ Р 34.10-2012 (`BigInt`, проективные координаты). Наборы параметров: 256 бит — `id-tc26-gost-3410-2012-256-paramSetA`…`D` и `id-GostR3410-2001-CryptoPro-A`, `-B`, `-C`, `-XchA`, `-XchB`; 512 бит — `id-tc26-gost-3410-12-512-paramSetA`…`C`. Кодирование открытого ключа и значения подписи — по RFC 4491 / RFC 9215 (little-endian ключ в `OCTET STRING`; подпись — `s ‖ r`). Точка ключа вне кривой — отказ.
- `cades.ts` — разбор `ContentInfo`/`SignedData` (`pkijs`) и проверки по порядку, первая неудача — отказ с текстом:
  1. `SignedData`, `eContent` нет (открепленная), один `SignerInfo` — иначе «неверный формат подписи»;
  2. сертификат подписанта (по `sid` из `certificates`) совпадает по DER с сертификатом подготовки — иначе «подпись сделана другим сертификатом»;
  3. `digestAlgorithm` — Стрибог длины подготовки (`1.2.643.7.1.1.2.2` / `.2.3`); подписанные атрибуты есть, `contentType` = `id-data`, `messageDigest` = хеш подготовки — иначе «подпись не соответствует документу»;
  4. `signatureAlgorithm` — ГОСТ Р 34.10-2012 той же длины (`1.2.643.7.1.1.1.1`/`.1.2` или `1.2.643.7.1.1.3.2`/`.3.3`); подпись над DER `SET OF` подписанных атрибутов (хеш Стрибог той же длины) верна — иначе «подпись недействительна»;
  5. метка `id-aa-signatureTimeStampToken` (неподписанный атрибут): при заданном `SIGN_GOST_TSA_URL` обязательна — иначе «нет метки времени»; если есть — `TSTInfo.messageImprint` равен хешу (алгоритм из метки: Стрибог-256/512 или SHA-256/384/512) значения `signature` из `SignerInfo`; подпись метки верна (ГОСТ — `gost3410.ts`, RSA/ECDSA — `pkijs`); `genTime` в пределах срока сертификата подписанта и в окне [время подготовки − 5 минут, время сервера + 5 минут] (время подготовки — `expires_at` ожидания минус срок ожидания; сертификат службы меток не проверяется, поэтому без нижней границы самодельная метка задала бы любое время подписи) — иначе «метка времени недействительна»;
  6. срок действия сертификата подписанта на время метки (если есть), иначе на время сервера — иначе «срок действия сертификата истёк».
- Не проверяются (справка и интерфейс говорят об этом прямо): цепочка до доверенного корня (Минцифры и др.), списки отзыва (CRL/OCSP), сертификат службы меток. Подлинность сертификата подтверждает сервис проверки (Госуслуги и др.).

### 42.5 Хранение
- Миграция 0014:
  - `report_run_signatures`: `method text not null default 'p12'` (`check in ('p12','gost')`), `sig_path text` (только у `gost`);
  - `gost_sign_pending`: `run_id uuid` — первичный ключ, ссылка на `report_runs` с `on delete cascade`; `user_id uuid not null` (ссылка на `users`, `cascade`); `cert_der bytea not null`; `hash bytea not null`; `hash_alg text not null`; `draft_path text not null`; `expires_at timestamptz not null`.
- Ежечасная очистка (как OIDC-сессии, §40) удаляет истёкшие ожидания и их черновики. Очистка по `REPORT_RETENTION_DAYS` и удаление пользователя — как §39.3 (каталог запуска с `.sig`, строки).

### 42.6 Скачивание и список запусков
- `GET /api/runs/:id/file?format=pdf&signed=1` — у ГОСТ-запуска PDF со штампом (`out.signed.pdf`), имя — с суффиксом `-signed`, как §39.3.
- `GET /api/runs/:id/file?format=sig` — `out.signed.pdf.sig` (`application/pkcs7-signature`), имя — имя подписанного PDF плюс `.sig`; права — как §24.4; запуск не подписан по ГОСТ — `404`; `signed`/`inline` с `format=sig` — `400`.
- `GET /api/runs`: у запуска `signature` (с `method`), `signable` — как §39.3, плюс `signMethod: 'p12' | 'gost' | null` из снимка.

### 42.7 Интерфейс
- `cadesplugin_api.js` — официальный скрипт КриптоПро — отдаётся статикой `apps/web` с нашего адреса (CSP не меняется); загружается только при открытии диалога ГОСТ-подписи. Если его условия не разрешают распространение в нашем образе — администратор кладёт файл сам (`docs/operations/gost-signature.md`), остальное не меняется. Работа с плагином — асинхронный вариант API (`cadesplugin.async_spawn` / промисы).
- Диалог «Подписать PDF» для `signMethod = 'gost'`:
  - плагин не загрузился за 10 секунд или CSP не найден — «Не найден КриптоПро ЭЦП Browser plug-in или КриптоПро CSP» со ссылками на установку и пояснением о запросе разрешения для сайта;
  - список действующих сертификатов ГОСТ Р 34.10-2012 из хранилища «Личное» текущего пользователя (с закрытым ключом): владелец (CN), издатель, срок; пусто — «Нет действующих сертификатов ГОСТ — установите сертификат в КриптоПро»;
  - «Подписать» → подготовка → подпись хеша → завершение; состояние ожидания; ошибки плагина — понятным текстом (отменено пользователем, неверный ПИН-код, служба меток недоступна; прочие — текст плагина), ошибки сервера — как §39.3;
  - после подписи — «Подписан: <CN>, ДД.ММ.ГГГГ ЧЧ:ММ» (с меткой — «, метка времени»), кнопки «Скачать PDF со штампом» и «Скачать подпись (.sig)»; пояснение «Подлинность сертификата проверяется сервисом проверки подписи (например, Госуслуги)».
- ReportRunPage и HistoryPage: для ГОСТ-запусков пункты «PDF со штампом» и «Подпись (.sig)»; подсказка значка подписи — «Подписан (ГОСТ): …» / «Подписан (.p12): …». Кнопка подписи у ГОСТ не зависит от наличия `.p12`.
- «Моя подпись»: блок «КриптоПро» — кнопка «Проверить плагин»: версии плагина и CSP, число действующих сертификатов ГОСТ или текст ошибки. Блок `.p12` — без изменений.

### 42.8 Настройка, справка, тесты, выпуск
- `SIGN_GOST_TSA_URL` — необязательный адрес службы меток с поддержкой ГОСТ (`http`/`https`, иначе API не стартует с понятной ошибкой); его использует плагин на компьютере пользователя (нужен сетевой доступ оттуда). compose (`.env.example`), Helm values (ConfigMap).
- Справка: README, раздел «Электронная подпись»; `docs/operations/gost-signature.md` — что установить пользователю (CSP 5.0, плагин, сертификат), браузеры (Chrome, Яндекс.Браузер, Edge, Firefox с расширением плагина; Safari — нет), служба меток, что сервер проверяет и что нет (§42.4), проверка пары на Госуслугах.
- Тестовые данные — `scripts/gost-fixtures.sh` (OpenSSL с движком `gost` в Docker, например `rnix/openssl-gost`; в CI не запускается, результат в `apps/api/test/fixtures/gost/`): тестовый УЦ; сертификаты 2012-256 (`paramSetA` и `CryptoPro-A`), 2012-512; открепленные CAdES-BES над хешем тестового PDF; CAdES-T с меткой ГОСТ (`openssl ts`); испорченные — другой хеш, другой сертификат, испорченное значение подписи, без подписанных атрибутов, с `eContent`.
- Тесты:
  - `apps/api` модульные: Стрибог — примеры ГОСТ Р 34.11-2012 и RFC 6986 (256 и 512), потоковый хеш = хеш целиком; ГОСТ Р 34.10-2012 — примеры приложения А стандарта и RFC 7091, неверная подпись, точка вне кривой, все наборы параметров на данных OpenSSL; `cades.ts` — все отказы §42.4 и успех; задачи пула `gost-prepare`/`gost-verify`; штамп (три положения, `/Rotate`, Info/XMP не меняются);
  - API (интеграционные): подготовка (все ошибки сертификата, замена ожидания) и завершение с подписью из тестовых данных (хеш черновика детерминирован: тест кладёт тестовый PDF как черновик либо подменяет `gost-prepare`), истёкшее ожидание — `409`, чужой запуск — `404`, `SIGN_BUSY`, метка обязательна при `SIGN_GOST_TSA_URL`, `format=sig`, снимок решает способ, очистка ожиданий и `.sig`, миграция существующих подписей (`method = 'p12'`);
  - `packages/shared`: `method` в `signature`, `RunSignature.method`;
  - web: плагин — подмена объекта `cadesplugin` (нет плагина, нет сертификатов, выбор и успех, отмена, ошибка сервера), выбор способа на вкладке «PDF», пункты скачивания, блок «КриптоПро» в «Моя подпись».
- Риск, который тесты без плагина не закрывают: порядок байтов хеша для `SetHashValue` и состав атрибутов, которые плагин кладёт в `SignHash`. Решение — хеш передаётся в том порядке, в каком его выдаёт `HashedData.Value` для тех же данных (по документации КриптоПро), а проверка §42.4 не требует атрибутов сверх `contentType` и `messageDigest` (лишние — `signingTime`, `signing-certificate-v2` и т. п. — допускаются). Окончательно подтверждается ручной приёмкой.
- Ручная приёмка перед тегом: владелец подписывает отчёт настоящим плагином на тестовом стенде и проверяет пару PDF + `.sig` на Госуслугах. Там же подтверждаются: загрузка `cadesplugin_api.js` и плагина при нашей CSP в Firefox и Яндекс.Браузере; порядок байтов хеша и hex в верхнем регистре для `SetHashValue`; метка службы КриптоПро TSP (ключ 2012) проходит проверку §42.4 — в токене есть сертификат службы.
- CHANGELOG 2.11.0. Ветка `feat/2.11.0` от `main` (2.10.1); PR, слияние и тег `v2.11.0` — с разрешения владельца.

## 43. 2.12.0: роли «Редактор» и «Распорядитель доступа»

Решения владельца 2026-10-21. Добавляются две роли, `admin` и `user` не меняются:
- **«Редактор» (`editor`)** создаёт шаблоны, правит свои и выданные ему, смотрит превью, назначает своим шаблонам категорию и группы. Строит отчёты по тем же правилам, что `user` (§19): превью шаблона ему доступно без групп, а построение — нет.
- **«Распорядитель доступа» (`access_manager`)** ведёт справочники групп и категорий, состав групп, а также назначает категорию, группы и флаг «доступен всем» любому шаблону. Содержимое шаблонов он не видит и не меняет. Отчёты строит как `user`.

### 43.1 Владелец и редакторы шаблона
- `templates.owner_id` ссылается на `users`, при удалении пользователя становится `NULL`. Владельцем становится тот, кто создал шаблон: пустым, загрузкой файла, копией или импортом с действием `create`/`copy`. У шаблонов, созданных до 2.12.0, `owner_id = NULL`: их правит только администратор, пока он не назначит владельца или редакторов.
- Таблица `template_editors (template_id, user_id)` с первичным ключом на пару. Записи удаляются каскадом вместе с шаблоном или пользователем.
- Право правки шаблона — `canEditTemplate(user, t)`. Его дают роль `admin`, а также роль `editor` при условии, что пользователь — владелец `t` или есть в `template_editors` для `t`. Роль проверяется по текущему значению из БД (`requireUser` перечитывает её при каждом запросе, §15.1). Поэтому если редактора понизить, конструктор ему сразу недоступен. Его записи в `template_editors` при этом остаются, но не действуют.
- Удалить шаблон могут `admin` и владелец с ролью `editor`. Выданные редакторы удалять не могут.
- Выдавать и забирать право правки могут владелец (роль `editor`) и `admin`, и только пользователям с ролью `editor`. Владельца в список не добавляют. Сменить владельца может только `admin`, и новым владельцем может стать только пользователь с ролью `editor`. При смене прежний владелец не попадает в список редакторов автоматически.

### 43.2 Права по ролям
| Действие | admin | editor | access_manager | user |
|---|---|---|---|---|
| Создать шаблон: пустой, загрузкой файла, импортом | ✓ | ✓, становится владельцем | — | — |
| Конструктор: файл, OnlyOffice, запросы и их пробный запуск, параметры, диаграммы, PDF и вложения, блокировка правки, превью, метаданные | все | `canEditTemplate` | — | — |
| Копировать, выгрузить в архив, импорт с `update` | все | `canEditTemplate`; копия — его | — | — |
| Удалить шаблон | все | владелец | — | — |
| Категория, группы, «доступен всем» у шаблона (`PUT /api/templates/:id/access`) | все | `canEditTemplate` | все | — |
| Редакторы шаблона | все | владелец | — | — |
| Группы и категории: создать, переименовать, удалить, связать категорию с группами, состав группы | ✓ | — (только чтение списков) | ✓ | — |
| Источники данных | ✓ | только список `id` и `name` (`/api/datasources/options`) | — | — |
| Список пользователей для выбора (`GET /api/users/directory`) | ✓ | ✓ | ✓ | — |
| Пользователи, роли, резервные копии, сертификаты других, OIDC-привязки | ✓ | — | — | — |
| Построение отчёта, история и скачивание своих запусков | все шаблоны; история — все запуски | по §19, история своя | по §19, история своя | по §19, история своя |
- Распорядитель доступа может включить себя в любую группу и так получить доступ к построению любого отчёта. Это следует из его права вести состав групп, и в документации об этом прямо сказано.
- Таблицы ролей в §7 и §8 описывают поведение до 2.12.0. Для маршрутов конструктора «admin» там теперь означает «`admin` или `editor` с `canEditTemplate`».

### 43.3 API
- `modules/access/permissions.ts`:
  - `requireRole(...roles)` — preHandler после `requireUser`, при другой роли отвечает `403`; `requireAdmin` превращается в `requireRole('admin')`.
  - `canEditTemplate(db, user, id)`, `assertTemplateEdit(db, user, id)`: шаблона нет или пользователь его не видит ни для правки, ни по §19 — `404`; видит по §19, но править не может — `403` «нет права на правку шаблона».
  - `assertTemplateOwnerOrAdmin` для удаления и для редакторов.
- Маршруты конструктора (templates, pdf-routes, edit-lock, onlyoffice `editor-config`/`save`, `queries/run`, `preview`, export, duplicate) переходят на `requireRole('admin','editor')` + `assertTemplateEdit`. Создание и загрузка — `requireRole('admin','editor')`, `owner_id` = текущий пользователь (у `admin` тоже).
- `GET /api/templates?scope=edit`: шаблоны, которые пользователь может править (у `admin` — все), в DTO конструктора с полями `ownerId` и `canDelete`. Без `scope` маршрут работает как раньше — список для построения по §19. `GET /api/templates/:id`: DTO конструктора, если есть `canEditTemplate`, иначе DTO пользователя по §19, иначе `404`.
- `GET /api/access/templates` (`admin`, `access_manager`): все шаблоны, у каждого `id`, `name`, `categoryId`, `groupIds`, `public`. Без запросов, параметров, файла и источника.
- `PUT /api/templates/:id/access`: `admin` и `access_manager` — любой шаблон; `editor` — при `canEditTemplate`. Тело и поведение не меняются.
- `GET`/`PUT /api/templates/:id/editors` `{ userIds }` — для владельца и `admin`. Пользователь не найден, роль не `editor` или это владелец — `400`.
- `PUT /api/templates/:id/owner` `{ userId }` — только `admin`, нужна роль `editor`.
- Группы и категории:
  - `GET /api/groups` и `GET /api/categories` открыты для `admin`, `access_manager` и `editor`;
  - изменения групп и категорий и `PUT /api/groups/:id/members` — для `admin` и `access_manager`;
  - `GET`/`PUT /api/users/:id/groups` остаются за `admin`.
- `GET /api/datasources/options` (`admin`, `editor`) отдаёт `[{ id, name }]` по имени; прочие маршруты источников остаются за `admin`.
- `GET /api/users/directory` (`admin`, `access_manager`, `editor`) отдаёт `[{ id, login, role }]` незаблокированных пользователей по логину; фильтр — `?role=editor`.
- Импорт (§33) для `editor`:
  - в предпросмотре `existing` перечисляет только шаблоны, которые он может править;
  - `update` чужого шаблона — `403`;
  - категория, которой нет, не создаётся: шаблон импортируется без категории; в предпросмотре у элемента `categorySkipped: true` и предупреждение «категория не будет создана».
- Роли: `Role` = `admin | editor | access_manager | user`; `LDAP_DEFAULT_ROLE` принимает все четыре; OIDC при первом входе назначает `user`, как раньше; запрет администратору понижать себя (users/routes) не меняется. Смена роли увеличивает `sessionVersion`, как раньше.

### 43.4 Миграция 0015
`templates.owner_id uuid NULL REFERENCES users ON DELETE SET NULL` + индекс; `template_editors (template_id uuid REFERENCES templates ON DELETE CASCADE, user_id uuid REFERENCES users ON DELETE CASCADE, PRIMARY KEY (template_id, user_id))` + индекс по `user_id`. Существующим шаблонам владелец не назначается.

### 43.5 Интерфейс
- Хук `usePermissions(me)` с флагами `canAuthor`, `canManageAccess`, `isAdmin` заменяет проверки `me.role === 'admin'` в меню и на страницах.
- Меню:
  - `editor` видит «Отчёты», «История», «Моя подпись» и «Шаблоны» — список `scope=edit` с кнопками «Создать», «Загрузить» и «Загрузить из архива»;
  - `access_manager` видит «Отчёты», «История», «Моя подпись», «Группы», «Категории» и «Доступ к отчётам»;
  - `admin` видит всё, включая «Доступ к отчётам».
- Страница «Доступ к отчётам» `/admin/access`: таблица шаблонов (название, категория, группы, «доступен всем») с поиском по названию. Строка открывает диалог с теми же полями, что вкладка «Настройки». Перехода в конструктор нет.
- Вкладка «Настройки» конструктора, блок «Редакторы» (виден владельцу и `admin`): владелец, если он есть; список выданных редакторов; добавление из `directory?role=editor`. У `admin` есть ещё «Сменить владельца». Если владельца нет, показывается «не назначен».
- В диалоге пользователя в выборе роли четыре значения: «Администратор», «Редактор», «Распорядитель доступа», «Пользователь».
- Пункты, на которые нет права, скрыты: удаление у выданного редактора, источники, пользователи. Прямой переход по адресу без права ведёт на `/reports`, как сейчас `RequireAdmin`.

### 43.6 Тесты и выпуск
- Интеграционные тесты:
  - матрица §43.2 по маршрутам: каждая роль × свой, выданный и чужой шаблон × ожидаемый код;
  - `editor` без групп получает превью и `403`/`404` при построении;
  - понижение `editor` до `user` сразу закрывает конструктор;
  - удаление владельца даёт `owner_id = NULL`;
  - импорт `editor`: `update` чужого — `403`, категория не создаётся;
  - `access_manager` не получает `GET /api/templates/:id` в DTO конструктора, а запросы — `403`.
- Веб-тесты: меню по четырём ролям, страница «Доступ к отчётам», блок «Редакторы», роли в диалоге пользователя.
- Документация: README (роли), справка в приложении, CHANGELOG 2.12.0. Ветка `feat/2.12.0` от `main` (`8f9c607`); PR, слияние и тег `v2.12.0` — с разрешения владельца.

### 43.7 2.12.1: подпись роли
Решение владельца 2026-10-21: роль `access_manager` в интерфейсе и документации называется «Менеджер безопасности» (было «Распорядитель доступа»). Ключ роли в API, БД, `LDAP_DEFAULT_ROLE` не меняется; миграции нет.

## 44. 2.13.0: локализация интерфейса (этап 1)

Решения владельца 2026-10-22. Локализация делится на этапы, у каждого — свой раздел спецификации и свой выпуск:
1. каркас, интерфейс, ошибки API, форматы дат в интерфейсе, документ о подходе (этот раздел, 2.13.0);
2. отчёты: язык штампа подписи и форматов Carbone;
3. справка по шаблонам;
4. документация (README, docs/).

Языки: `ru` (основной и исходный), `en`, `es`, `pt-BR`, `fr`, `de`, `zh-CN`. Языков с письмом справа налево нет. Переводы делает Claude по глоссарию. Языки, которые носитель ещё не вычитал, отмечены в `docs/localization.md`.

### 44.1 Языки и выбор языка
- В shared: `LOCALES = ['ru','en','es','pt-BR','fr','de','zh-CN'] as const`, тип `Locale` и `LOCALE_NAMES` с самоназваниями: «Русский», «English», «Español», «Português (Brasil)», «Français», «Deutsch», «简体中文».
- `users.locale text NULL` (миграция 0016). `NULL` — пользователь язык не выбирал. Значение вне `LOCALES` при чтении считается `NULL`.
- `PUT /api/me/locale` `{ locale: Locale | null }` → `204`, любая роль; неизвестный язык — `400 VALIDATION`. `GET /api/auth/me` отдаёт `locale` (выбранный или `null`).
- `DEFAULT_LOCALE` (env, значение из `LOCALES`, по умолчанию `ru`; Helm — `config.defaultLocale`). Публичный `GET /api/i18n` (без входа) отдаёт `{ defaultLocale }`; `/api/version` не меняется (он требует входа).
- Язык интерфейса определяется в таком порядке:
  1. `me.locale`, если пользователь его выбрал;
  2. первый язык из `navigator.languages`, у которого есть каталог. Сравнение идёт по точному тегу, затем по основному подтегу: `pt-PT` → `pt-BR`, `zh-TW`/`zh-HK` → `zh-CN`, `en-GB` → `en`;
  3. `defaultLocale`.

  До входа используются только пункты 2 и 3.
- Переключатель языка:
  - в нижнем меню боковой панели («Язык»): выбор сразу меняет язык и сохраняет его через `PUT /api/me/locale`;
  - на странице входа: выбор хранится только в `localStorage` и стоит выше пункта 2;
  - пункт «Как в браузере» сбрасывает выбор в `null`.

### 44.2 Каталоги
- `packages/shared/src/i18n/<locale>/<namespace>.json`. Пространства имён:
  - `common` — общие кнопки, статусы, меню;
  - по разделам интерфейса: `reports`, `history`, `signature`, `templates`, `editor`, `admin`;
  - `errors` — ошибки API;
  - `validation` — собственные сообщения схем shared.

  Состав разделов уточняет план. Источник — `ru`, остальные каталоги содержат те же ключи.
- Формат — i18next JSON v4: параметры `{{name}}`, множественное число суффиксами CLDR. Для `ru` это `_one/_few/_many/_other`, для `en/es/pt-BR/fr/de` — `_one/_other` (у `fr` и `es` дополнительно `_many`, если его требует CLDR), для `zh-CN` — только `_other`. Вложенность ключей — не глубже двух уровней.
- Общий модуль `packages/shared/src/i18n/index.ts` со стабильным API:
  - `createTranslator(locale) → t(key, params?)`;
  - `resolveLocale(candidates: string[], fallback: Locale): Locale` — правило из §44.1;
  - `zodLocale(locale)` — встроенные сообщения zod: `ru`, `en`, `es`, `pt`, `fr`, `de`, `zh-CN`.

  Модуль используют и web, и API.
- Запасная цепочка при отсутствии ключа: `<locale>` → `en` → `ru`. В рабочем выпуске до неё не доходит благодаря проверке из §44.6.

### 44.3 Веб
- `i18next` + `react-i18next`. Каталог `ru` входит в основной бандл, остальные языки — отдельные чанки (`import()`), загружаются при выборе.
- Все видимые тексты в `apps/web/src` переходят на `t()`, кроме справки (`pages/admin/help/**`, этап 3) и тестов. Подписи из shared (`ROLE_LABELS` и подобные) заменяются ключами каталога: `ROLE_LABELS` удаляется, роль выводится через `t('common:role.<role>')`.
- Языковые настройки окружения выставляются вместе со сменой языка:
  - `<html lang>`;
  - `ThemeProvider lang` и `configure({ lang })` uikit: `ru` → `ru`, остальные → `en`, так как uikit знает только эти два языка;
  - локаль `@gravity-ui/date-utils` (`ru`, `en`, `es`, `pt-br`, `fr`, `de`, `zh-cn`);
  - все `Intl.*` и `localeCompare` в `lib/format.ts`, `DocumentTab`, `ReportsPage` берут текущий язык, а не `'ru-RU'`.
- Каждый запрос `api/*` несёт заголовок `X-Locale: <текущий язык>`.
- Сообщения проверки форм на клиенте (схемы shared) переводятся тем же способом, что и на сервере (§44.4).
- OnlyOffice `editorConfig.lang` и `region` берутся из языка запроса (`ru-RU`, `en-US`, `es-ES`, `pt-BR`, `fr-FR`, `de-DE`, `zh-CN`). Конвертация при рендере (`onlyoffice-convert.ts`) и `CARBONE_LANG` не меняются — это этап 2.

### 44.4 API
- Язык запроса `req.locale` определяется так:
  1. `X-Locale`, если значение есть в `LOCALES`;
  2. иначе лучший язык из `Accept-Language` по правилу `resolveLocale`;
  3. иначе `DEFAULT_LOCALE`.

  Выбор пользователя (`users.locale`) веб уже учёл, когда выставлял `X-Locale`, поэтому сервер его не читает.
- `AppError(code, status, key, params?, details?, internal?)`: вместо готового русского текста передаются ключ каталога `errors` и параметры. Обработчик ошибок переводит его на `req.locale`. Форма ответа не меняется: `{ error: { code, message, details? } }`, `message` — уже переведённый текст.
- Перевод полевых ошибок:
  - для ошибок `VALIDATION` переводятся и тексты полей в `details`;
  - для ошибок zod: если `issue.message` — ключ каталога `validation` (с префиксом `v:`), он переводится через `t`, иначе текст строится через `zodLocale(req.locale).localeError(issue)`;
  - глобальный `z.config(z.locales.ru())` в shared удаляется;
  - собственные сообщения схем shared (`'неверный идентификатор'` и т. п.) становятся ключами `v:…`.
- Тексты для оператора остаются на русском и не переводятся: журнал, ошибки конфигурации при запуске (`config.ts`), сообщения CLI-скриптов.
- `CLIENT_ERROR_MESSAGES` (коды Fastify `FST_*`) переходят на ключи каталога `errors`.

### 44.5 Документ о подходе
`docs/localization.md` (на русском) описывает:
- структуру каталогов и пространств имён;
- правило выбора языка (§44.1);
- ключи: имена, параметры, множественное число по CLDR, запрет склеивать фразы из кусков;
- глоссарий терминов по всем языкам: шаблон, отчёт, запуск, источник данных, группа, категория, владелец, редактор, менеджер безопасности, подпись, штамп, превью и т. д.;
- как добавить язык по шагам: код в `LOCALES` и `LOCALE_NAMES`, каталоги, сопоставление для uikit, date-utils, zod и OnlyOffice, проверка, скриншоты-сверка, вычитка;
- как проверить полноту (`pnpm i18n:check`);
- таблицу состояния языков («вычитан носителем: да/нет») и как прислать исправления;
- что сейчас не переводится и в каком этапе будет переведено (§44, этапы 2–4).

### 44.6 Проверки и тесты
- `pnpm i18n:check` (скрипт `scripts/i18n-check.ts`, в CI в задаче «Проверки»). Сборка падает, если:
  - в каком-то языке нет ключа, который есть в `ru`, или есть лишний;
  - параметры `{{…}}` в переводе не совпадают с `ru`;
  - не хватает форм множественного числа, которых требует CLDR для языка (`Intl.PluralRules(locale).resolvedOptions().pluralCategories`);
  - в `apps/web/src` вне `*.test.*`, `pages/admin/help/**` и комментариев встречается кириллица в строковых литералах или тексте JSX, что означает непереведённую строку;
  - в `apps/api/src` в `new AppError(`/`badRequest(`/`notFound(`/`conflict(`/`forbidden(` передан литерал с кириллицей вместо ключа.
- Веб-тесты закрепляют язык `ru` в `test/setup.tsx`, существующие ожидания не меняются. Новые тесты:
  - переключение языка в меню меняет подписи и вызывает `PUT /api/me/locale`;
  - правило `resolveLocale`;
  - на странице входа язык браузера `de-AT` даёт `de`;
  - заголовок `X-Locale` уходит в запросах.
- Тесты API:
  - `X-Locale: en` у ошибок 400/404/409 даёт английский `message`, без заголовка — `DEFAULT_LOCALE`;
  - ошибка zod на `en` и `de`;
  - `PUT /api/me/locale` с неизвестным языком — 400;
  - `GET /api/auth/me` возвращает `locale`;
  - `GET /api/i18n` без входа возвращает `defaultLocale`.
- Выпуск: CHANGELOG 2.13.0, README (переключатель языка, `DEFAULT_LOCALE`). Ветка `feat/2.13.0` от `main` (`2e34dbd`); PR, слияние и тег — с разрешения владельца.

## 45. 2.14.0: локализация отчётов (этап 2)

Решения владельца 2026-10-22. Этап 2 из §44: язык форматов Carbone, штампа подписи и нумерации страниц PDF. Не входят: перевод текста шаблона (`{t()}` и словари Carbone; отдельный выпуск, если понадобится), справка по шаблонам (этап 3), документация (этап 4), китайский текст в диаграммах.

### 45.1 Язык отчёта в шаблоне
- `templates.report_locale text NOT NULL` — значение из `LOCALES` или `'user'` («как у пользователя»). В shared: `ReportLocale = Locale | 'user'`, схема `zodReportLocale`.
- Миграция 0017 добавляет колонку и записывает всем существующим шаблонам `'ru'`: прежние отчёты строились по-русски и должны строиться так же при любом `DEFAULT_LOCALE`.
- Новый шаблон получает `DEFAULT_LOCALE`; копия шаблона сохраняет значение исходного.
- Поле «Язык отчёта» — во вкладке «Настройки» конструктора: 7 языков (самоназвания из `LOCALE_NAMES`) и «Как у пользователя». Менять может тот, у кого есть право правки шаблона (§43). В подсказке к полю: язык задаёт формат дат и чисел, валюту `formatC` по умолчанию, штамп подписи и нумерацию страниц; текст шаблона не переводится.
- Экспорт шаблонов несёт `reportLocale`; при импорте отсутствующее значение (выгрузки до 2.14.0) считается `'ru'`, неизвестное — `400 IMPORT_INVALID`, как прочие ошибки манифеста.

### 45.2 Определение языка при построении
- Язык отчёта = `templates.report_locale`; для `'user'` — `me.locale` строящего, иначе язык запроса (§44.4: `X-Locale` → `Accept-Language`), иначе `DEFAULT_LOCALE`.
- Превью в конструкторе, построение отчёта и подпись используют одно и то же правило; язык определяется один раз на построение и передаётся дальше (Carbone, OnlyOffice, PDF), а не вычисляется в каждом модуле заново.
- Запуск запоминает определённый язык: `report_runs.report_locale text NULL` (миграция 0017). Подпись запуска (`.p12` и ГОСТ, в том числе позже, из истории) и сборка другого формата из снимка берут язык запуска, а не текущую настройку шаблона. У запусков до 2.14.0 значение `NULL` и считается `'ru'`.

### 45.3 Carbone и OnlyOffice
- `CARBONE_LANG` удаляется. Язык отчёта переводится в `options.lang` Carbone по таблице (в shared, `CARBONE_LANGS`): `ru`→`ru`, `en`→`en-us`, `es`→`es-es`, `pt-BR`→`pt-br`, `fr`→`fr-fr`, `de`→`de-de`, `zh-CN`→`zh-cn`.
- Валюта `formatC` по умолчанию следует за языком, как в Carbone (`currencySource`/`currencyTarget` не задаются): RUB, USD, EUR, BRL, EUR, EUR, CNY. Это решение владельца; предупреждение — в подсказке поля (§45.1) и в CHANGELOG.
- `region` конвертации через OnlyOffice (`onlyoffice-convert.ts`) — по языку отчёта (`ru-RU`, `en-US`, `es-ES`, `pt-BR`, `fr-FR`, `de-DE`, `zh-CN`), та же таблица, что у `editorConfig.region` (§44.4).

### 45.4 PDF: штамп и нумерация
- Новое серверное пространство имён каталога `report` (7 языков; в веб-бандл не попадает, как `errors`). Строки штампа (§39.5) — ключи `report:stamp.title|certificate|owner|valid|signed` с параметрами; даты и время — `Intl.DateTimeFormat` языка отчёта в часовом поясе `config.tz`. Для `ru` строки и формат дат совпадают с прежними дословно.
- `PdfPageNumbers.format` становится необязательным (без `.default`). Пусто → формат языка отчёта из таблицы `PAGE_FORMATS` в shared (`ru`: «Стр. {page} из {pages}»; таблица данных, как `CARBONE_LANGS`, — её читают и сервер, и конструктор). `PDF_PAGE_FORMAT_DEFAULT` удаляется.
- Миграция 0017 удаляет `format` у тех шаблонов, где он равен «Стр. {page} из {pages}», — у русских отчётов результат не меняется.
- Конструктор: поле формата пустое, формат по языку отчёта показан подсказкой (placeholder); это заменяет подстановку из каталога `editor:pdf.pageFormatDefault` (2.13.0), ключ удаляется.

### 45.5 Шрифт для китайского
- В образ API добавляется Noto Sans SC Regular (OFL) рядом с Noto Sans (`packages/carbone/assets/fonts`). В PDF встраивается подмножество использованных символов.
- Шрифт выбирается на строку: все символы есть в Noto Sans — Noto Sans (Bold для заголовка штампа); иначе — Noto Sans SC Regular (заголовок без жирного). Символы, которых нет ни в одном шрифте, по-прежнему заменяются на «?» (§36, R2).
- Это касается штампа, нумерации страниц, водяного знака и других текстов, которые рисует постобработка PDF.
- Проверка §36.2 при сохранении настроек PDF отклоняет только символы, которых нет ни в одном из двух шрифтов: китайский водяной знак или формат нумерации сохраняются.
- Первая задача плана проверяет, что выбранный файл шрифта встраивается pdf-lib подмножеством и текст извлекается из PDF; если нет — берётся другой формат файла того же шрифта.

### 45.6 Проверки и тесты
- Рендер на `en`, `de`, `zh-CN`: `formatD` (название месяца), `formatN` (разделители), `formatC` (валюта по таблице §45.3); на `ru` — как до 2.14.0.
- Штамп на 7 языках; на `zh-CN` текст извлекается из PDF без «?»; на `ru` — дословно прежние строки.
- Нумерация: пустой формат → формат языка отчёта; заданный формат не меняется.
- Миграция 0017: существующие шаблоны получают `'ru'`, формат «Стр. {page} из {pages}» удаляется, другой формат остаётся.
- `'user'`: язык профиля, затем язык запроса, затем `DEFAULT_LOCALE`.
- Язык запуска: подпись и сборка из снимка после смены настройки шаблона — на языке запуска; запуск до 2.14.0 — `ru`.
- Экспорт/импорт с `reportLocale` и без него.
- `pnpm i18n:check` знает пространство имён `report`.
- `docs/localization.md`: раздел о языке отчёта, «что не переводится» обновляется (штамп, нумерация и форматы Carbone из списка уходят); README и CHANGELOG `2.14.0`.
