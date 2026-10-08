# Управление бэкапами из админки (План 15) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Администратор прямо в веб-интерфейсе видит список бэкапов, запускает бэкап и восстанавливает данные из выбранного бэкапа без доступа к хосту; `scripts/restore.sh` остаётся аварийным путём.

**Architecture:**
- **Агент бэкапа** — новый пакет `apps/backup-agent` (TypeScript, Fastify 5, vitest). Он работает внутри образа сервиса `backup` и вызывает существующие скрипты как дочерние процессы: `backup.sh`, `entrypoint.sh restore-storage`, `lib.sh` (`check_storage_backend`, `s3_env`). Скрипты не переписываются, только дополняются: `BACKUP_NAME` в `backup.sh`, `RESTORE_DIR` в `restore-storage`, замок в режиме `now`.
  - **Слои агента:**
    - чистые модули (`config`, `cron`, `manifest`, `backups`, `migrations`, `redact`, `recovery`);
    - движок операций `BackupAgent` (`agent.ts`): фазы, `state.json`, коды восстановления, флаг обслуживания. Шаги приходят снаружи через интерфейс `Steps`, поэтому движок целиком проверяется юнит-тестами на подделках;
    - реальные шаги `createSteps` (`steps.ts`): скрипты, `pg_restore`/`psql`, миграции drizzle, Redis, `pg_terminate_backend`;
    - HTTP (`server.ts`) и точка входа `main.ts`.
  - **Одна операция за раз:** замок в процессе (`running`) плюс `flock` на `/backups/.op.lock`. Замок держит процесс-«держатель» `sh -c 'exec 9>>…; flock -n 9 || exit 75; echo locked; exec cat >/dev/null'`: он живёт, пока открыт его stdin. Агент отпускает замок, закрывая stdin; если агент умер, pipe закрывается сам и замок снимается. `entrypoint.sh now` берёт тот же замок через `exec 9>>/backups/.op.lock; flock -n 9` и при занятости выходит с кодом 75.
  - **Флаг обслуживания:** все записи `cr:maintenance` (SET, DEL, повтор каждые 5 с) идут через одну цепочку промисов (`flagChain`). Нужное значение вычисляется в момент выполнения из текущего состояния, поэтому повтор, поставленный в очередь до снятия флага, не вернёт его после `done`.
- **Образ `backup`** собирается многоэтапным `docker/backup/Dockerfile`, контекст — корень репозитория:
  - этап `build` (`node:22-bookworm-slim`, тот же базовый образ, что у `api`; слой уже в кэше): `pnpm install --filter @carbone-reports/backup-agent...`, `tsup`, затем `pnpm deploy --prod --legacy /out`;
  - итоговый образ: `postgres:17-alpine` + `apk add rclone nodejs`; агент лежит в `/agent`, миграции `apps/api/drizzle` — в `/agent/drizzle`, скрипты копируются в `/backup`.

  **Почему так:**
  - Агент и миграции берутся из того же коммита, что API (§26.2: проверка `last_migration` и донакатка). Поэтому образ собирается из корня репозитория, как `api`. CI уже собирает `backup` с `context: .`.
  - Скрипты копируются в образ, а не монтируются. Агент вызывает скрипты именно своей версии, образ самодостаточен для Helm (План 16), и `docker compose` из GHCR работает без каталога `docker/backup`.
  - Зависимости агента — чистый JS (fastify, pg, ioredis, drizzle-orm, croner, zod), поэтому `node_modules` из glibc-этапа работают на musl. Бандл одним файлом не делается: у fastify/pino есть динамические `require`.
  - Cache mounts BuildKit не используются: образ должен собираться и классическим сборщиком из testcontainers (`GenericContainer.fromDockerfile`) в интеграционных тестах агента.
- **Режимы `entrypoint.sh`:** `agent` (по умолчанию, `exec node /agent/dist/main.js` после `check_backup_timeout` и `check_storage_backend`), `now`, `restore-storage`. Режим `cron` и busybox `crond` удаляются; расписание задаёт `croner` внутри агента: `BACKUP_CRON` проверяется на ровно 5 полей, как раньше, часовой пояс — `TZ`.
- **Восстановление** (`BackupAgent.runRestore`):
  1. `verify`: файлы, sha256, `last_migration` среди хешей `/agent/drizzle` (через `readMigrationFiles` из `drizzle-orm/migrator`: sha256 содержимого SQL-файла), `rclone lsf` бакета для `s3`, `/data` на запись для `local`.
  2. `pre-backup`: `backup.sh` с `BACKUP_NAME=pre-restore-<время>`, затем в каталоге остаются 3 последних `pre-restore-*`.
  3. `maintenance`: `SET cr:maintenance`, через `BACKUP_AGENT_TERMINATE_DELAY_MS` (3000) `pg_terminate_backend` для `application_name = 'api'`.
  4. `db`: `pg_restore -f` и `psql -1` с `DROP SCHEMA drizzle/public`.
  5. `migrate`: `migrate()` drizzle из `/agent/drizzle`.
  6. `storage`: `entrypoint.sh restore-storage` с `RESTORE_DIR=/backups/<имя>`.
  7. `redis`: `SCAN` + `UNLINK` всего, кроме `cr:maintenance`.
  8. `done`.

  Каждая смена фазы атомарно пишется в `/backups/.op/state.json` (`writeFile` во временный файл + `rename`, записи последовательны). Сбой на фазах 4–7 переводит агент в состояние «требуется восстановление»: флаг остаётся, в stdout печатается `КОД ВОССТАНОВЛЕНИЯ: XXXX-XXXX-XXXX`, в `state.json` хранится только sha256 кода.
- **API:**
  - конфигурация `BACKUP_AGENT_URL`/`BACKUP_AGENT_TOKEN` (`config.backupAgent`);
  - зависимость `deps.backupAgent: AgentClient | null` (тайм-аут 10 с, ошибки связи → 502 `backup_agent_unavailable`);
  - модуль `backups` (прокси, только admin; выключен → 404 `backups_disabled`);
  - признак `features.backups` в ответах `/api/auth/me` и `/api/auth/login`;
  - модуль `maintenance`: хук `onRequest` с кэшем 1 с и fail-open, публичные `GET /api/maintenance` и `POST /api/maintenance/retry` с лимитом Redis 10 за 15 минут на IP.

  Пулы `pg` API получают `application_name: 'api'`. У основного пула появляется обработчик `error`: без него `pg_terminate_backend` простаивающего соединения уронил бы процесс. Когда флаг снят, API сбрасывает пулы источников данных: после восстановления их настройки в базе могли измениться.
- **Web:**
  - страница «Бэкапы» (таблица, кнопка «Сделать бэкап», панель операции с опросом раз в 2 с, диалог восстановления с вводом имени);
  - `MaintenanceGate` над роутером: любой ответ 503 `maintenance` (`reportMaintenance()` в `api/client.ts`) показывает экран на всю страницу с опросом `/api/maintenance` раз в 3 с, формой кода в состоянии «требуется восстановление» и перезагрузкой страницы по окончании.
- **Порядок задач:**
  - Task 1–3 — агент без Docker: юнит-тесты на хосте;
  - Task 4 — образ, скрипты, compose, `restore.sh` и интеграционные тесты агента в контейнере;
  - Task 5–6 — API;
  - Task 7–8 — web;
  - Task 9 — E2E, README, заметки и живой прогон.

**Tech Stack:**
- агент: Node 22, TypeScript 5.9, Fastify ^5.12.5, `ioredis` ^5.11.1, `pg` ^8.23.1, `drizzle-orm` ^0.45.3, `zod` ^4.6.5, **`croner` ^10.0.1** (новая зависимость: cron с часовыми поясами; проверено: `new Cron('61 * * * *')` и неизвестный `timezone` бросают ошибку, опция `mode: '5-part'` есть), vitest ^5.0.3, testcontainers ^12.2.0, tsup ^8.5.1, `yaml` ^2.9.1;
- образ: `postgres:17-alpine` + `rclone` + `nodejs` (apk), busybox `flock`, `mountpoint`;
- API: Fastify 5, zod 4, ioredis; web: React 19, Gravity UI, TanStack Query 5; E2E: Playwright.

**Spec:** `docs/superpowers/specs/2026-10-02-carbone-reports-design.md`, §26 (контекст — §17, §20.4, §21, §25.3).

## Global Constraints

- Node 22: каждую команду начинать с `source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null &&`.
- Гейты: `pnpm typecheck && pnpm lint && pnpm exec prettier --check . && pnpm test`. Если менялся `apps/api` — ещё `pnpm --filter @carbone-reports/api test:int`, если менялся агент или `docker/backup` — `pnpm --filter @carbone-reports/backup-agent test:int` (с Task 4). Код в плане может быть не отформатирован по prettier, поэтому перед гейтами — `pnpm exec prettier --write <изменённые файлы>` (`.sh` и `Dockerfile` prettier не форматирует).
- Сообщения коммитов заканчиваются строкой `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- `.env`, `certs/` и `backups/` не коммитятся. Секреты не печатаются в вывод: `ADMIN_PASSWORD`, `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `S3_*`, `BACKUP_AGENT_TOKEN`, код восстановления из живого прогона. Скрипты берут их из `.env` или окружения контейнера сами. `docker compose config` (кроме `--quiet`) и `env` не запускать.
- Перед `docker build`, `up --build`, `pnpm stack:demo` и первым `test:int` агента (он собирает образ): `df -h /System/Volumes/Data`. Если свободно меньше 3 GiB — BLOCKED. Не делать `prune` чужих docker-ресурсов. Удалять можно только висячие образы проекта `carbone-reports` и тестовый образ `carbone-reports-backup:it`. `down` — без `-v`.
- Новая зависимость npm — только `croner` (в `apps/backup-agent`). Остальные зависимости агента — те же версии, что уже есть в lockfile. Новых образов из реестра нет: сборка идёт `FROM node:22-bookworm-slim` и `FROM postgres:17-alpine` (оба уже скачаны).
- Тексты для людей (журналы, сообщения об ошибках, интерфейс) — на русском. Идентификаторы в коде — на английском.
- Коды ошибок, заданные спецификацией, пишутся буквально, строчными: `backups_disabled`, `backup_agent_unavailable`, `maintenance`. Остальные коды, как в проекте, — заглавными (`BUSY`, `BAD_CODE`, `NO_RECOVERY`, `NOT_FOUND`, `BAD_NAME`, `UNAUTHORIZED`, `TOO_MANY_ATTEMPTS`).
- §26.1:
  - агент слушает `8080` только во внутренней сети `backup`, публикуемых портов нет;
  - каждый запрос, кроме `GET /health`, требует `Authorization: Bearer <BACKUP_AGENT_TOKEN>`; сравнение за постоянное время; без токена из 32 и более символов агент не стартует;
  - 409 `{ busy: { type, startedAt } }` при параллельной операции; cron при занятом `flock` пропускается с записью в журнал;
  - `GET /backups` — поля `name`, `createdAt`, `dbSize`, `storageSize`, `lastMigration`, `kind` (`regular` | `pre-restore`), `status` (`ok` | `partial`), новые сверху;
  - имя для восстановления — `^(pre-restore-)?\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$`, каталог должен существовать;
  - `GET /operation` — `id`, `type`, `requestedBy`, `phase`, `status`, `startedAt`, `finishedAt`, `error`, `log` (хвост до 500 строк), `recovery`;
  - журнал операции — `/backups/.op/<id>.log`, хранятся последние 20; из вывода дочерних процессов вырезаются значения переменных с `PASSWORD`, `SECRET`, `TOKEN`, `KEY` в имени длиной от 6 символов;
  - `BACKUP_KEEP` — только для обычных бэкапов; `pre-restore-*` — последние 3.
- §26.2: фазы `verify → pre-backup → maintenance → db → migrate → storage → redis → done`; `state.json` атомарно; `cr:maintenance` = `{ phase, startedAt, backup }` без TTL; `pg_terminate_backend` через 3 с; повтор флага каждые 5 с, пока состояние требует обслуживания; рестарт на фазах 1–3 → `failed` и флаг снят, на 4–7 → «требуется восстановление».
- §26.3: таймаут к агенту 10 с, 502 `backup_agent_unavailable` «Агент бэкапа недоступен»; 503 `maintenance` на всё, кроме `GET /api/health`, `GET /api/maintenance`, `POST /api/maintenance/retry`; кэш 1 с; Redis недоступен → fail-open; лимит `retry` 10 за 15 минут с IP, без Redis лимит пропускается.
- §26.4: код — 12 символов base32 (`crypto.randomBytes`), печатается строкой `КОД ВОССТАНОВЛЕНИЯ: XXXX-XXXX-XXXX`, в `state.json` только sha256; верный код → восстановление с фазы `maintenance` без нового `pre-backup`, 202; неверный → 403, после 5 неверных код сгорает и печатается новый; нет состояния → 409; новый код при каждом сбое; `restore.sh` останавливает `backup`, помечает незавершённое восстановление `failed (resolved externally)` перед запуском агента и делает `FLUSHALL`.
- §26.5: колонки «Дата», «Тип», «Размер», «Миграция», «Статус»; кнопка «Сделать бэкап»; панель операции с опросом раз в 2 с; «Восстановить» только у `ok`; подтверждение точным именем; экран «Идёт восстановление из бэкапа…» с опросом раз в 3 с и перезагрузкой; форма кода с кнопками «Повторить восстановление из `<имя>`» и «Вернуть состояние до восстановления (`pre-restore-…`)».
- §26.6: `backup` вне профиля, `command: ['agent']`, сети `default`, `s3`, `cache`, `backup`; `BACKUP_AGENT_TOKEN: ${BACKUP_AGENT_TOKEN:?…}`, `REDIS_URL` с паролем; `api` получает `BACKUP_AGENT_URL`, `BACKUP_AGENT_TOKEN` и сеть `backup`.

## Review Focus

1. **Флаг обслуживания застрял или пропал.** Опасные места:
   - повтор каждые 5 с, поставленный в очередь до `done`, возвращает флаг после снятия, и API навсегда отвечает 503;
   - DEL упал (Redis мигнул), и флаг висит без восстановления;
   - Redis перезапущен посреди восстановления, и API начинает работать с наполовину заменённой базой;
   - после рестарта агента флаг не снят (фазы 1–3) или не возвращён (фазы 4–7).

   Тест: Task 2, `agent.test.ts`: «повтор флага не возвращает его после снятия», «DEL не прошёл — таймер снимает флаг позже», «рестарт на фазе pre-backup: операция failed, флаг снят, кода нет», «рестарт на фазе migrate: требуется восстановление, флаг на месте, новый код». Task 4, `agent.int.test.ts`: «сбой на этапе storage: флаг остаётся и возвращается после удаления…».
2. **Новые операции, пока база заменена частично.** Опасные места:
   - бэкап по cron в состоянии «требуется восстановление» снимает копию полуготовой базы, и ротация `BACKUP_KEEP` вытесняет исправные копии;
   - запрос нового восстановления в обход кода;
   - двойной клик «Восстановить» запускает две операции.

   Тест: Task 2, `agent.test.ts`: «в состоянии «требуется восстановление» бэкап и восстановление отклоняются», «одновременные запросы: второй получает busy с типом и временем первой операции». Task 4, `agent.int.test.ts`: «409 при параллельной операции: второй запрос и ручной now; замок у постороннего процесса».
3. **API после `pg_terminate_backend` и после восстановления.** Опасные места:
   - у основного пула `createDb` нет обработчика `error`: завершённое простаивающее соединение роняет процесс API;
   - сессии API без `application_name` не завершаются, и `DROP SCHEMA` ждёт их замков;
   - кэш пулов источников данных хранит настройки и пароли, которых после восстановления в базе уже нет.

   Тест: Task 5, `backups.int.test.ts`: «соединения API помечены application_name=api и переживают pg_terminate_backend». Task 6, `flag.test.ts`: «onEnd вызывается при снятии флага, один раз»; `maintenance.int.test.ts`: «после снятия флага запросы проходят, пулы источников сброшены».
4. **Утечка секретов и кода восстановления.** Опасные места:
   - код попадает в журнал операции (его видно через `GET /operation` и API) или в `state.json`;
   - пароли `PGPASSWORD`, `S3_SECRET_ACCESS_KEY` или пароль из `REDIS_URL` попадают в журнал из вывода `pg_dump`, `rclone` или `psql`;
   - токен агента виден в ответе API или в тексте ошибки конфигурации;
   - сравнение токена зависит от длины или содержимого.

   Тест: Task 1, `redact.test.ts`, `config.test.ts` («значение токена не попадает в ошибку»). Task 2, `agent.test.ts` «код только в stdout: не в журнале операции и не в state.json (там sha256)». Task 3, `server.test.ts` «токен другой длины — 401». Task 4, `agent.int.test.ts` «восстановление: …» (в журнале операции нет секрета S3 и пароля Redis) и «сбой на этапе storage…» (кода нет в журнале операции и в `state.json`). Task 5, `backups.int.test.ts` «агент отклонил токен, упал (5xx), ответил не-JSON или не уложился в срок — 502; токена в ответе нет».
5. **Замок и ручной `now`.** Опасные места:
   - `docker compose run backup now` во время восстановления из админки;
   - агент умер, а `flock` остался у процесса-сироты;
   - `restore.sh` идёт при работающем агенте, и тот возвращает флаг после `FLUSHALL`.

   Тест: Task 2, `lock.test.ts` («замок держит и shell-скрипт через тот же файл (entrypoint.sh now)», «замок снимается, когда умер процесс-владелец (stdin держателя закрылся)»). Task 4, `agent.int.test.ts` «409 при параллельной операции: второй запрос и ручной now; замок у постороннего процесса». Task 9, Step 4: ручной `now` из отдельного контейнера при занятом замке и `restore.sh` из состояния «требуется восстановление».

---

## Task 1: Пакет `apps/backup-agent`: конфигурация, cron, манифест, список бэкапов, миграции, фильтр секретов, коды (§26.1, §26.2, §26.4)

**Files:**
- Create: `apps/backup-agent/package.json`, `apps/backup-agent/tsconfig.json`, `apps/backup-agent/vitest.config.ts`, `apps/backup-agent/tsup.config.ts`
- Create: `apps/backup-agent/src/config.ts`, `src/config.test.ts`
- Create: `apps/backup-agent/src/cron.ts`, `src/cron.test.ts`
- Create: `apps/backup-agent/src/manifest.ts`, `src/manifest.test.ts`
- Create: `apps/backup-agent/src/backups.ts`, `src/backups.test.ts`
- Create: `apps/backup-agent/src/migrations.ts`, `src/migrations.test.ts`
- Create: `apps/backup-agent/src/redact.ts`, `src/redact.test.ts`
- Create: `apps/backup-agent/src/recovery.ts`, `src/recovery.test.ts`
- Modify: `pnpm-lock.yaml` (через `pnpm install`)

`pnpm-workspace.yaml` уже включает `apps/*`, корневые `typecheck`, `lint`, `test` подхватят пакет сами. Скрипт `test:int` пакет получит в Task 4 вместе с `vitest.int.config.ts`: до этого корневой `pnpm test:int` не должен ссылаться на несуществующий конфиг.

**Interfaces:**
- Consumes: `readMigrationFiles({ migrationsFolder })` из `drizzle-orm/migrator` (`hash` = sha256 текста SQL-файла, проверено в `drizzle-orm@0.45.3/migrator.js`); `apps/api/drizzle/meta/_journal.json`.
- Produces:
  - `loadAgentConfig(env: NodeJS.ProcessEnv): AgentConfig` — бросает `Error('Неверная конфигурация агента: …')` или `Error(CRON_FIELDS_ERROR)`;
  - `interface AgentConfig { token: string; port: number; redisUrl: string; storageBackend: 'local' | 's3'; cron: string; tz: string; backupsDir: string; scriptsDir: string; migrationsDir: string; terminateDelayMs: number; reassertMs: number }`;
  - `pgConnection(env): PgConnection` (`{ host, port, user, database, password? }`, по умолчанию `postgres:5432`, `app`, `app`);
  - `CRON_FIELDS_ERROR = 'BACKUP_CRON: ожидается 5 полей cron'`, `checkCron(expr, tz): string`, `scheduleCron(expr, tz, fn): () => void`;
  - `parseManifest(text): Manifest`, `MANIFEST_FILES = ['db.dump', 'storage.tar.gz']`, `interface Manifest { createdUtc: string | null; lastMigration: string | null; files: Record<'db.dump' | 'storage.tar.gz', { size: number; sha256: string }> }`;
  - `BACKUP_NAME_RE`, `PRE_RESTORE_KEEP = 3`, `backupName(at: Date, prefix?: '' | 'pre-restore-'): string`, `listBackups(dir): Promise<BackupInfo[]>`, `selectPreRestoreToDelete(names, keep?)`, `rotatePreRestore(dir, keep?): Promise<string[]>`, `interface BackupInfo { name; createdAt; dbSize: number | null; storageSize: number | null; lastMigration: string | null; kind: 'regular' | 'pre-restore'; status: 'ok' | 'partial' }`;
  - `bundledMigrationHashes(folder): string[]`, `FUTURE_BACKUP = 'бэкап создан более новой версией приложения'`, `assertKnownMigration(last, known): void`;
  - `type Redact = (s: string) => string`, `createRedactor(env): Redact`;
  - `generateCode(rand?): string` (`XXXX-XXXX-XXXX`), `normalizeCode`, `hashCode(code): string` (sha256 hex), `codeMatches(input, hash): boolean`, `MAX_ATTEMPTS = 5`.

- [ ] **Step 1: Пакет и зависимости**

`apps/backup-agent/package.json`:

```json
{
  "name": "@carbone-reports/backup-agent",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsup",
    "start": "node dist/main.js",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "croner": "^10.0.1",
    "drizzle-orm": "^0.45.3",
    "fastify": "^5.12.5",
    "ioredis": "^5.11.1",
    "pg": "^8.23.1",
    "zod": "^4.6.5"
  },
  "devDependencies": {
    "@testcontainers/postgresql": "^12.2.0",
    "@types/node": "^22.20.5",
    "@types/pg": "^8.23.1",
    "testcontainers": "^12.2.0",
    "tsup": "^8.5.1",
    "vitest": "^5.0.3",
    "yaml": "^2.9.1"
  }
}
```

`apps/backup-agent/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test", "*.ts"] }
```

`apps/backup-agent/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['src/**/*.test.ts'], environment: 'node' },
});
```

`apps/backup-agent/tsup.config.ts` (точка входа `src/main.ts` появится в Task 3, сборка запускается только в Docker с Task 4):

```ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  target: 'node22',
  clean: true,
});
```

```bash
cd /Users/sam/carbone-reports
source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null && pnpm install
git diff --stat pnpm-lock.yaml        # добавлены importer apps/backup-agent и пакет croner@10.0.1
```

- [ ] **Step 2: Падающие тесты**

`apps/backup-agent/src/config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadAgentConfig, pgConnection } from './config';

const base = { BACKUP_AGENT_TOKEN: 't'.repeat(32), REDIS_URL: 'redis://:pw@redis:6379' };

describe('loadAgentConfig', () => {
  it('значения по умолчанию', () => {
    expect(loadAgentConfig(base)).toEqual({
      token: 't'.repeat(32),
      port: 8080,
      redisUrl: 'redis://:pw@redis:6379',
      storageBackend: 'local',
      cron: '0 3 * * *',
      tz: 'UTC',
      backupsDir: '/backups',
      scriptsDir: '/backup',
      migrationsDir: '/agent/drizzle',
      terminateDelayMs: 3000,
      reassertMs: 5000,
    });
  });

  it('без токена агент не стартует', () => {
    expect(() => loadAgentConfig({ REDIS_URL: base.REDIS_URL })).toThrow(
      'Неверная конфигурация агента: BACKUP_AGENT_TOKEN: обязателен',
    );
  });

  it('токен короче 32 символов — ошибка; значение токена не попадает в ошибку', () => {
    const short = 'Zq9-secret-value-0123456789abcd'; // 31 символ
    expect(short).toHaveLength(31);
    let message = '';
    try {
      loadAgentConfig({ ...base, BACKUP_AGENT_TOKEN: short });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toBe('Неверная конфигурация агента: BACKUP_AGENT_TOKEN: минимум 32 символа');
  });

  it('REDIS_URL обязателен', () => {
    expect(() => loadAgentConfig({ BACKUP_AGENT_TOKEN: base.BACKUP_AGENT_TOKEN })).toThrow(
      'REDIS_URL: обязателен',
    );
  });

  it('BACKUP_CRON не из 5 полей — прежнее сообщение', () => {
    expect(() => loadAgentConfig({ ...base, BACKUP_CRON: '0 3 * *' })).toThrow(
      /^BACKUP_CRON: ожидается 5 полей cron$/,
    );
  });

  it('BACKUP_CRON, TZ, STORAGE_BACKEND и пути из окружения', () => {
    expect(
      loadAgentConfig({
        ...base,
        BACKUP_CRON: '30  2 * * 1-5',
        TZ: 'Europe/Moscow',
        STORAGE_BACKEND: 's3',
        BACKUPS_DIR: '/tmp/b',
        BACKUP_SCRIPTS_DIR: '/it-scripts',
        BACKUP_AGENT_TERMINATE_DELAY_MS: '500',
      }),
    ).toMatchObject({
      cron: '30 2 * * 1-5',
      tz: 'Europe/Moscow',
      storageBackend: 's3',
      backupsDir: '/tmp/b',
      scriptsDir: '/it-scripts',
      terminateDelayMs: 500,
    });
  });

  it('неверный STORAGE_BACKEND', () => {
    expect(() => loadAgentConfig({ ...base, STORAGE_BACKEND: 'ftp' })).toThrow(
      'STORAGE_BACKEND: ожидается local или s3',
    );
  });
});

describe('pgConnection', () => {
  it('значения по умолчанию — как в backup.sh', () => {
    expect(pgConnection({ PGPASSWORD: 'x' })).toEqual({
      host: 'postgres',
      port: 5432,
      user: 'app',
      database: 'app',
      password: 'x',
    });
  });
  it('PGHOST, PGPORT, PGUSER, PGDATABASE из окружения', () => {
    expect(
      pgConnection({ PGHOST: 'db', PGPORT: '6543', PGUSER: 'u', PGDATABASE: 'd' }),
    ).toMatchObject({ host: 'db', port: 6543, user: 'u', database: 'd' });
  });
});
```

`apps/backup-agent/src/cron.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkCron, CRON_FIELDS_ERROR, scheduleCron } from './cron';

describe('checkCron', () => {
  it.each(['0 3 * * *', '*/15 2-4 * * 1-5', '0 0 1 1 *'])('принимает %j', (expr) => {
    expect(checkCron(expr, 'Europe/Moscow')).toBe(expr);
  });
  it('лишние пробелы и табуляции между полями допустимы', () => {
    expect(checkCron(' 0\t3  * * * ', 'UTC')).toBe('0 3 * * *');
  });
  it.each(['', '0 3 * *', '0 3 * * * *', '@daily', '0 3 * * *\n', '0 3\n* * *'])(
    'не 5 полей или перевод строки: %j',
    (expr) => {
      expect(() => checkCron(expr, 'UTC')).toThrow(CRON_FIELDS_ERROR);
    },
  );
  it('неверное значение поля', () => {
    expect(() => checkCron('61 * * * *', 'UTC')).toThrow(
      'BACKUP_CRON: неверное выражение «61 * * * *» или часовой пояс TZ=UTC',
    );
  });
  it('неизвестный часовой пояс', () => {
    expect(() => checkCron('0 3 * * *', 'Mars/Base')).toThrow(/TZ=Mars\/Base/);
  });
});

describe('scheduleCron', () => {
  afterEach(() => vi.useRealTimers());
  it('вызывает функцию в момент по расписанию и после stop больше не вызывает', async () => {
    vi.useFakeTimers({ now: new Date('2026-10-08T02:59:58Z') });
    const fn = vi.fn();
    const stop = scheduleCron('0 3 * * *', 'UTC', fn);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fn).toHaveBeenCalledTimes(1);
    stop();
    await vi.advanceTimersByTimeAsync(2 * 86_400_000);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
```

`apps/backup-agent/src/manifest.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseManifest } from './manifest';

const h = (c: string) => c.repeat(64);
const text = [
  'created_utc=2026-10-08T03-00-00Z',
  `last_migration=${h('a')}`,
  `db.dump size=123 sha256=${h('b')}`,
  `storage.tar.gz size=45 sha256=${h('c')}`,
  '',
].join('\n');

describe('parseManifest', () => {
  it('разбирает manifest.txt из backup.sh', () => {
    expect(parseManifest(text)).toEqual({
      createdUtc: '2026-10-08T03-00-00Z',
      lastMigration: h('a'),
      files: {
        'db.dump': { size: 123, sha256: h('b') },
        'storage.tar.gz': { size: 45, sha256: h('c') },
      },
    });
  });
  it('last_migration=? или пусто — null (backup.sh пишет «?», если запрос к drizzle не удался)', () => {
    expect(parseManifest(text.replace(`last_migration=${h('a')}`, 'last_migration=?')).lastMigration).toBeNull();
    expect(parseManifest(text.replace(`last_migration=${h('a')}`, 'last_migration=')).lastMigration).toBeNull();
  });
  it('CRLF и посторонние строки не мешают', () => {
    expect(parseManifest(`# заметка\r\n${text.replaceAll('\n', '\r\n')}`).files['db.dump'].size).toBe(123);
  });
  it('нет строки файла — ошибка', () => {
    expect(() => parseManifest(text.replace(/^storage.*$/m, ''))).toThrow(
      'manifest.txt: нет строки storage.tar.gz',
    );
  });
});
```

`apps/backup-agent/src/backups.test.ts`:

```ts
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BACKUP_NAME_RE,
  backupName,
  listBackups,
  rotatePreRestore,
  selectPreRestoreToDelete,
} from './backups';

const h = (c: string) => c.repeat(64);
const manifest = (db: number, st: number, mig = h('a')) =>
  [
    'created_utc=x',
    `last_migration=${mig}`,
    `db.dump size=${db} sha256=${h('b')}`,
    `storage.tar.gz size=${st} sha256=${h('c')}`,
  ].join('\n');

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'backups-'));
});
afterEach(() => rm(root, { recursive: true, force: true }));

async function dir(name: string, files: Record<string, string> = {}) {
  await mkdir(join(root, name));
  for (const [f, content] of Object.entries(files)) await writeFile(join(root, name, f), content);
}

describe('listBackups', () => {
  it('каталоги бэкапов новыми сверху; .partial и каталог без manifest — partial; прочее не попадает', async () => {
    await dir('2026-10-08T03-00-00Z', { 'manifest.txt': manifest(100, 200) });
    await dir('pre-restore-2026-10-08T04-00-00Z', { 'manifest.txt': manifest(1, 2) });
    await dir('2026-10-08T05-00-00Z.partial', { 'db.dump': '0123456789' });
    await dir('2026-10-07T03-00-00Z', { 'db.dump': 'x' });
    await dir('.op');
    await dir('notes');
    await writeFile(join(root, '2026-10-06T03-00-00Z'), 'файл, не каталог');
    expect(await listBackups(root)).toEqual([
      {
        name: '2026-10-08T05-00-00Z.partial',
        createdAt: '2026-10-08T05:00:00Z',
        dbSize: 10,
        storageSize: null,
        lastMigration: null,
        kind: 'regular',
        status: 'partial',
      },
      {
        name: 'pre-restore-2026-10-08T04-00-00Z',
        createdAt: '2026-10-08T04:00:00Z',
        dbSize: 1,
        storageSize: 2,
        lastMigration: h('a'),
        kind: 'pre-restore',
        status: 'ok',
      },
      {
        name: '2026-10-08T03-00-00Z',
        createdAt: '2026-10-08T03:00:00Z',
        dbSize: 100,
        storageSize: 200,
        lastMigration: h('a'),
        kind: 'regular',
        status: 'ok',
      },
      {
        name: '2026-10-07T03-00-00Z',
        createdAt: '2026-10-07T03:00:00Z',
        dbSize: 1,
        storageSize: null,
        lastMigration: null,
        kind: 'regular',
        status: 'partial',
      },
    ]);
  });
  it('нет каталога — пустой список', async () => {
    expect(await listBackups(join(root, 'нет'))).toEqual([]);
  });
});

describe('имена', () => {
  it('backupName — как date -u +%Y-%m-%dT%H-%M-%SZ в backup.sh', () => {
    const at = new Date('2026-10-08T03:04:05.678Z');
    expect(backupName(at)).toBe('2026-10-08T03-04-05Z');
    expect(backupName(at, 'pre-restore-')).toBe('pre-restore-2026-10-08T03-04-05Z');
  });
  it('BACKUP_NAME_RE — шаблон из §26.1', () => {
    expect(BACKUP_NAME_RE.test('2026-10-08T03-04-05Z')).toBe(true);
    expect(BACKUP_NAME_RE.test('pre-restore-2026-10-08T03-04-05Z')).toBe(true);
    for (const bad of ['2026-10-08T03-04-05Z.partial', '../2026-10-08T03-04-05Z', 'pre-restore-', '.op'])
      expect(BACKUP_NAME_RE.test(bad)).toBe(false);
  });
});

describe('ротация pre-restore', () => {
  const pre = (d: number) => `pre-restore-2026-10-0${d}T00-00-00Z`;
  it('из pre-restore остаются 3 новых; обычные и .partial не учитываются', () => {
    const names = [pre(1), pre(2), pre(3), pre(4), pre(5), '2026-10-01T00-00-00Z', `${pre(9)}.partial`];
    expect(selectPreRestoreToDelete(names)).toEqual([pre(2), pre(1)]);
  });
  it('rotatePreRestore удаляет каталоги на диске и не трогает обычные бэкапы', async () => {
    for (const d of [1, 2, 3, 4]) await dir(pre(d));
    await dir('2026-10-01T00-00-00Z');
    await dir(`${pre(9)}.partial`);
    expect(await rotatePreRestore(root)).toEqual([pre(1)]);
    expect((await readdir(root)).sort()).toEqual(
      ['2026-10-01T00-00-00Z', pre(2), pre(3), pre(4), `${pre(9)}.partial`].sort(),
    );
  });
});
```

`apps/backup-agent/src/migrations.test.ts`:

```ts
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { assertKnownMigration, bundledMigrationHashes, FUTURE_BACKUP } from './migrations';

/** Те же миграции, что Dockerfile копирует в /agent/drizzle. */
const folder = fileURLToPath(new URL('../../api/drizzle', import.meta.url));

describe('миграции в образе', () => {
  it('хеши — sha256 SQL-файлов в порядке журнала, как в drizzle.__drizzle_migrations', async () => {
    const journal = JSON.parse(await readFile(join(folder, 'meta/_journal.json'), 'utf8')) as {
      entries: { tag: string }[];
    };
    const expected = await Promise.all(
      journal.entries.map(async (e) =>
        createHash('sha256')
          .update(await readFile(join(folder, `${e.tag}.sql`), 'utf8'))
          .digest('hex'),
      ),
    );
    expect(expected.length).toBeGreaterThanOrEqual(7);
    expect(bundledMigrationHashes(folder)).toEqual(expected);
  });

  it('assertKnownMigration: известная — ок, неизвестная — «из будущего», нет версии — отказ', () => {
    const known = bundledMigrationHashes(folder);
    expect(() => assertKnownMigration(known[0]!, known)).not.toThrow();
    expect(() => assertKnownMigration('f'.repeat(64), known)).toThrow(FUTURE_BACKUP);
    expect(() => assertKnownMigration(null, known)).toThrow(
      'в manifest.txt нет last_migration: версия схемы бэкапа неизвестна',
    );
  });
});
```

`apps/backup-agent/src/redact.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createRedactor } from './redact';

describe('createRedactor', () => {
  const redact = createRedactor({
    PGPASSWORD: 'pg-pass-123',
    S3_SECRET_ACCESS_KEY: 'secretkey',
    S3_ACCESS_KEY_ID: 'AKIA12',
    BACKUP_AGENT_TOKEN: 'tok'.repeat(11),
    REDIS_URL: 'redis://:redis%2Fpw1@redis:6379',
    SHORT_PASSWORD: 'abc12',
    S3_BUCKET: 'carbone-reports',
    PATH: '/usr/bin',
  });

  it('вырезает значения переменных с PASSWORD, SECRET, TOKEN, KEY в имени от 6 символов', () => {
    expect(redact(`pg_dump: pg-pass-123; rclone: secretkey AKIA12 ${'tok'.repeat(11)}`)).toBe(
      'pg_dump: ***; rclone: *** *** ***',
    );
  });
  it('пароль из REDIS_URL — тоже секрет', () => {
    expect(redact('NOAUTH redis/pw1')).toBe('NOAUTH ***');
  });
  it('короткие значения и несекретные переменные не трогает', () => {
    expect(redact('abc12 carbone-reports /usr/bin')).toBe('abc12 carbone-reports /usr/bin');
  });
  it('сначала длинные значения: секрет, содержащий другой секрет, вырезается целиком', () => {
    const r = createRedactor({ A_PASSWORD: 'secret', B_SECRET: 'secret-long' });
    expect(r('x secret-long y secret')).toBe('x *** y ***');
  });
});
```

`apps/backup-agent/src/recovery.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { codeMatches, generateCode, hashCode, MAX_ATTEMPTS } from './recovery';

describe('коды восстановления', () => {
  it('12 символов base32 в виде XXXX-XXXX-XXXX', () => {
    for (let i = 0; i < 50; i++) expect(generateCode()).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
  });
  it('символ — младшие 5 бит байта из randomBytes (256 делится на 32 — без перекоса)', () => {
    const bytes = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 25, 26, 31, 32]);
    expect(generateCode(() => bytes)).toBe('ABCD-EFGH-Z27A');
  });
  it('хранится sha256; ввод сравнивается без учёта регистра, пробелов и дефисов', () => {
    const hash = hashCode('ABCD-EFGH-Z27A');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(codeMatches(' abcd efgh-z27a ', hash)).toBe(true);
    expect(codeMatches('ABCDEFGHZ27A', hash)).toBe(true);
    expect(codeMatches('ABCD-EFGH-Z27B', hash)).toBe(false);
    expect(codeMatches('', hash)).toBe(false);
  });
  it('лимит неверных попыток — 5', () => {
    expect(MAX_ATTEMPTS).toBe(5);
  });
});
```

- [ ] **Step 3: Запуск — должно упасть**

Run: `source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null && pnpm --filter @carbone-reports/backup-agent test`
Expected: FAIL — `Failed to resolve import "./config"` (и так же для остальных модулей).

- [ ] **Step 4: Реализация**

`apps/backup-agent/src/cron.ts`:

```ts
import { Cron } from 'croner';

/** То же сообщение, что у прежнего режима cron в entrypoint.sh (README, §20.4). */
export const CRON_FIELDS_ERROR = 'BACKUP_CRON: ожидается 5 полей cron';

/**
 * Ровно 5 полей через пробелы или табуляции, без перевода строки (как `set -- $BACKUP_CRON`
 * в прежнем entrypoint.sh). Значения полей и часовой пояс проверяет croner. Возвращает
 * выражение с одиночными пробелами.
 */
export function checkCron(expr: string, tz: string): string {
  if (/[\r\n]/.test(expr)) throw new Error(CRON_FIELDS_ERROR);
  const fields = expr.split(/[ \t]+/).filter(Boolean);
  if (fields.length !== 5) throw new Error(CRON_FIELDS_ERROR);
  const normalized = fields.join(' ');
  try {
    const job = new Cron(normalized, { timezone: tz, paused: true, mode: '5-part' });
    job.nextRun();
    job.stop();
  } catch {
    throw new Error(`BACKUP_CRON: неверное выражение «${normalized}» или часовой пояс TZ=${tz}`);
  }
  return normalized;
}

/** Запуск fn по расписанию в часовом поясе tz; protect — не накладывать запуски друг на друга. */
export function scheduleCron(expr: string, tz: string, fn: () => void): () => void {
  const job = new Cron(expr, { timezone: tz, mode: '5-part', protect: true }, () => fn());
  return () => job.stop();
}
```

`apps/backup-agent/src/config.ts`:

```ts
import { z } from 'zod';
import { checkCron } from './cron';

const Env = z.object({
  BACKUP_AGENT_TOKEN: z.string({ error: 'обязателен' }).min(32, 'минимум 32 символа'),
  BACKUP_AGENT_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  REDIS_URL: z.string({ error: 'обязателен' }).min(1, 'обязателен'),
  STORAGE_BACKEND: z.enum(['local', 's3'], { error: 'ожидается local или s3' }).default('local'),
  BACKUP_CRON: z.string().default('0 3 * * *'),
  TZ: z.string().min(1).default('UTC'),
  BACKUPS_DIR: z.string().min(1).default('/backups'),
  BACKUP_SCRIPTS_DIR: z.string().min(1).default('/backup'),
  MIGRATIONS_DIR: z.string().min(1).default('/agent/drizzle'),
  // Для тестов: задержка перед pg_terminate_backend (§26.2: 3 с) и период повтора флага (5 с).
  BACKUP_AGENT_TERMINATE_DELAY_MS: z.coerce.number().int().min(0).default(3000),
  BACKUP_AGENT_REASSERT_MS: z.coerce.number().int().min(100).default(5000),
});

export interface AgentConfig {
  /** Не логируется и не попадает в сообщения об ошибках. */
  token: string;
  port: number;
  redisUrl: string;
  storageBackend: 'local' | 's3';
  cron: string;
  tz: string;
  /** Каталог бэкапов (том BACKUP_DIR). */
  backupsDir: string;
  /** Скрипты docker/backup в образе. */
  scriptsDir: string;
  /** Миграции apps/api/drizzle того же коммита. */
  migrationsDir: string;
  terminateDelayMs: number;
  reassertMs: number;
}

export function loadAgentConfig(env: NodeJS.ProcessEnv): AgentConfig {
  const r = Env.safeParse(env);
  if (!r.success) {
    // Только имена переменных и правила — значения (токен) в сообщение не попадают.
    const msg = r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Неверная конфигурация агента: ${msg}`);
  }
  const e = r.data;
  return {
    token: e.BACKUP_AGENT_TOKEN,
    port: e.BACKUP_AGENT_PORT,
    redisUrl: e.REDIS_URL,
    storageBackend: e.STORAGE_BACKEND,
    cron: checkCron(e.BACKUP_CRON, e.TZ),
    tz: e.TZ,
    backupsDir: e.BACKUPS_DIR,
    scriptsDir: e.BACKUP_SCRIPTS_DIR,
    migrationsDir: e.MIGRATIONS_DIR,
    terminateDelayMs: e.BACKUP_AGENT_TERMINATE_DELAY_MS,
    reassertMs: e.BACKUP_AGENT_REASSERT_MS,
  };
}

export interface PgConnection {
  host: string;
  port: number;
  user: string;
  database: string;
  password?: string;
}

/** Подключение агента к базе приложения: те же PG* и умолчания, что у backup.sh. */
export function pgConnection(env: NodeJS.ProcessEnv): PgConnection {
  return {
    host: env.PGHOST || 'postgres',
    port: Number(env.PGPORT || 5432),
    user: env.PGUSER || 'app',
    database: env.PGDATABASE || 'app',
    password: env.PGPASSWORD,
  };
}
```

`apps/backup-agent/src/manifest.ts`:

```ts
export const MANIFEST_FILES = ['db.dump', 'storage.tar.gz'] as const;
export type ManifestFileName = (typeof MANIFEST_FILES)[number];

export interface ManifestFile {
  size: number;
  sha256: string;
}

export interface Manifest {
  createdUtc: string | null;
  /** Хеш последней миграции drizzle; null — backup.sh записал «?» или строки нет. */
  lastMigration: string | null;
  files: Record<ManifestFileName, ManifestFile>;
}

/** manifest.txt из backup.sh: created_utc=…, last_migration=…, «<файл> size=N sha256=…». */
export function parseManifest(text: string): Manifest {
  let createdUtc: string | null = null;
  let lastMigration: string | null = null;
  const files: Partial<Record<ManifestFileName, ManifestFile>> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    let m: RegExpExecArray | null;
    if ((m = /^created_utc=(.+)$/.exec(line))) createdUtc = m[1]!;
    else if ((m = /^last_migration=(.*)$/.exec(line)))
      lastMigration = m[1] && m[1] !== '?' ? m[1] : null;
    else if ((m = /^(db\.dump|storage\.tar\.gz) size=(\d+) sha256=([0-9a-f]{64})$/.exec(line)))
      files[m[1] as ManifestFileName] = { size: Number(m[2]), sha256: m[3]! };
  }
  for (const f of MANIFEST_FILES) if (!files[f]) throw new Error(`manifest.txt: нет строки ${f}`);
  return { createdUtc, lastMigration, files: files as Record<ManifestFileName, ManifestFile> };
}
```

`apps/backup-agent/src/backups.ts`:

```ts
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseManifest, type Manifest } from './manifest';

/** Имя бэкапа для восстановления (§26.1). */
export const BACKUP_NAME_RE = /^(pre-restore-)?\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/;
const DIR_RE = /^(?:pre-restore-)?(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z(\.partial)?$/;
const PRE_RESTORE_RE = /^pre-restore-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/;

/** Сколько бэкапов pre-restore-* хранить (§26.1); BACKUP_KEEP на них не действует. */
export const PRE_RESTORE_KEEP = 3;

export interface BackupInfo {
  name: string;
  /** ISO-время UTC из имени каталога. */
  createdAt: string;
  dbSize: number | null;
  storageSize: number | null;
  lastMigration: string | null;
  kind: 'regular' | 'pre-restore';
  status: 'ok' | 'partial';
}

/** Имя каталога, как `date -u +%Y-%m-%dT%H-%M-%SZ` в backup.sh. */
export function backupName(at: Date, prefix: '' | 'pre-restore-' = ''): string {
  return prefix + at.toISOString().replace(/\.\d{3}Z$/, 'Z').replaceAll(':', '-');
}

async function sizeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

/**
 * Каталоги бэкапов, новые сверху. `status: ok` — только завершённый каталог (без .partial)
 * с читаемым manifest.txt; остальное — `partial` (восстановить его нельзя).
 */
export async function listBackups(dir: string): Promise<BackupInfo[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const out: BackupInfo[] = [];
  for (const name of names) {
    const m = DIR_RE.exec(name);
    if (!m) continue;
    const path = join(dir, name);
    if (!(await stat(path)).isDirectory()) continue;
    let manifest: Manifest | null = null;
    try {
      manifest = parseManifest(await readFile(join(path, 'manifest.txt'), 'utf8'));
    } catch {
      manifest = null;
    }
    out.push({
      name,
      createdAt: `${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`,
      dbSize: manifest?.files['db.dump'].size ?? (await sizeOf(join(path, 'db.dump'))),
      storageSize:
        manifest?.files['storage.tar.gz'].size ?? (await sizeOf(join(path, 'storage.tar.gz'))),
      lastMigration: manifest?.lastMigration ?? null,
      kind: name.startsWith('pre-restore-') ? 'pre-restore' : 'regular',
      status: m[5] || !manifest ? 'partial' : 'ok',
    });
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.name.localeCompare(a.name));
}

/** Какие завершённые pre-restore-* удалить, чтобы осталось keep новых. */
export function selectPreRestoreToDelete(names: string[], keep = PRE_RESTORE_KEEP): string[] {
  return names
    .filter((n) => PRE_RESTORE_RE.test(n))
    .sort()
    .reverse()
    .slice(keep);
}

export async function rotatePreRestore(dir: string, keep = PRE_RESTORE_KEEP): Promise<string[]> {
  const victims = selectPreRestoreToDelete(await readdir(dir), keep);
  for (const v of victims) await rm(join(dir, v), { recursive: true, force: true });
  return victims;
}
```

`apps/backup-agent/src/migrations.ts`:

```ts
import { readMigrationFiles } from 'drizzle-orm/migrator';

export const FUTURE_BACKUP = 'бэкап создан более новой версией приложения';

/**
 * Хеши миграций в образе (/agent/drizzle — apps/api/drizzle того же коммита). drizzle считает
 * hash как sha256 текста SQL-файла и пишет его в drizzle.__drizzle_migrations; backup.sh кладёт
 * последний из них в manifest.txt как last_migration.
 */
export function bundledMigrationHashes(folder: string): string[] {
  return readMigrationFiles({ migrationsFolder: folder }).map((m) => m.hash);
}

/** Бэкап можно восстановить, только если его схема — одна из известных этой версии (§26.2, verify). */
export function assertKnownMigration(last: string | null, known: readonly string[]): void {
  if (!last) throw new Error('в manifest.txt нет last_migration: версия схемы бэкапа неизвестна');
  if (!known.includes(last)) throw new Error(FUTURE_BACKUP);
}
```

`apps/backup-agent/src/redact.ts`:

```ts
const SECRET_NAME = /PASSWORD|SECRET|TOKEN|KEY/;
export const MIN_SECRET_LENGTH = 6;

export type Redact = (s: string) => string;

/**
 * Фильтр вывода дочерних процессов (§26.1): значения переменных окружения с PASSWORD, SECRET,
 * TOKEN или KEY в имени длиной от 6 символов заменяются на «***». Пароль Redis входит в
 * REDIS_URL, имя переменной его не выдаёт, поэтому он добавляется отдельно.
 */
export function createRedactor(env: NodeJS.ProcessEnv): Redact {
  const values = new Set<string>();
  for (const [k, v] of Object.entries(env))
    if (v && v.length >= MIN_SECRET_LENGTH && SECRET_NAME.test(k)) values.add(v);
  const url = env.REDIS_URL;
  if (url && URL.canParse(url)) {
    const password = decodeURIComponent(new URL(url).password);
    if (password.length >= MIN_SECRET_LENGTH) values.add(password);
  }
  // Длинные первыми: значение, содержащее другое значение, вырезается целиком.
  const sorted = [...values].sort((a, b) => b.length - a.length);
  return (s) => sorted.reduce((acc, v) => acc.split(v).join('***'), s);
}
```

`apps/backup-agent/src/recovery.ts`:

```ts
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** После стольких неверных попыток код сгорает и печатается новый (§26.4). */
export const MAX_ATTEMPTS = 5;

/** 12 символов base32 (60 бит) в виде XXXX-XXXX-XXXX. */
export function generateCode(rand: (n: number) => Buffer = randomBytes): string {
  const chars = [...rand(12)].map((b) => ALPHABET[b & 31]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}

export const normalizeCode = (input: string) => input.toUpperCase().replace(/[\s-]/g, '');

/** В state.json хранится только это значение. */
export const hashCode = (code: string) =>
  createHash('sha256').update(normalizeCode(code)).digest('hex');

export function codeMatches(input: string, hash: string): boolean {
  return timingSafeEqual(Buffer.from(hashCode(input), 'hex'), Buffer.from(hash, 'hex'));
}
```

- [ ] **Step 5: Запуск — должно пройти**

Run: `source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null && pnpm --filter @carbone-reports/backup-agent test`
Expected: PASS — все тесты Step 2.

- [ ] **Step 6: Гейты и коммит**

```bash
cd /Users/sam/carbone-reports
source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null && pnpm exec prettier --write apps/backup-agent && pnpm typecheck && pnpm lint && pnpm exec prettier --check . && pnpm test
git add apps/backup-agent pnpm-lock.yaml
git commit -m "feat(backup-agent): package with config, cron check, manifest, backup list, migration guard, redaction, recovery codes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Task 2: Движок операций: `state.json`, журналы, замок, дочерние процессы, фазы, коды и флаг (§26.1, §26.2, §26.4)

**Files:**
- Create: `apps/backup-agent/src/state.ts`, `src/state.test.ts`
- Create: `apps/backup-agent/src/oplog.ts`, `src/oplog.test.ts`
- Create: `apps/backup-agent/src/lock.ts`, `src/lock.test.ts`
- Create: `apps/backup-agent/src/run.ts`, `src/run.test.ts`
- Create: `apps/backup-agent/src/agent.ts`, `src/agent.test.ts`

**Interfaces:**
- Consumes (Task 1): `generateCode`, `hashCode`, `codeMatches`, `MAX_ATTEMPTS` (`recovery.ts`); `type Redact` (`redact.ts`).
- Produces:
  - `state.ts`: `RESTORE_PHASES`, `type RestorePhase`, `type Phase = RestorePhase | 'backup'`, `MAINTENANCE_PHASES`, `DB_PHASES`, `interface Operation { id; type: 'backup' | 'restore'; requestedBy: string; backup: string | null; preRestore: string | null; recoveryOf: string | null; maintenanceStartedAt: string | null; phase: Phase; status: 'running' | 'succeeded' | 'failed'; startedAt: string; finishedAt: string | null; error: string | null }`, `interface RecoveryState { codeHash: string; attempts: number; backup: string; preRestore: string | null; phase: RestorePhase; startedAt: string }`, `interface AgentState { operation: Operation | null; recovery: RecoveryState | null }`, `interface StateStore { read(): Promise<AgentState>; write(s: AgentState): Promise<void> }`, `emptyState()`, `fileStateStore(dir)` (файл `<dir>/state.json`), `RESOLVED_EXTERNALLY = 'resolved externally: scripts/restore.sh'`, `resolveExternally(store, now?): Promise<boolean>`;
  - `oplog.ts`: `interface OpLog { write(line): void; close(): Promise<void> }`, `interface OpLogs { open(id): Promise<OpLog>; tail(id): Promise<string[]> }`, `fileOpLogs(dir, keep = 20, tailLines = 500)`;
  - `lock.ts`: `type Release = () => Promise<void>`, `interface FileLock { tryAcquire(): Promise<Release | null> }`, `FLOCK_HOLDER_SCRIPT`, `LOCK_BUSY_EXIT = 75`, `flockFile(path): FileLock`;
  - `run.ts`: `type Out = (line: string) => void`, `interface RunOptions { env: NodeJS.ProcessEnv; out: Out; redact: Redact }`, `type Runner = (cmd, args, o: RunOptions) => Promise<void>`, `run: Runner`, `childEnv(env, extra?)`;
  - `agent.ts`: `interface MaintenanceFlag { phase: RestorePhase; startedAt: string; backup: string }`, `interface Steps` (см. код), `interface Busy { type: 'backup' | 'restore'; startedAt: string | null }`, `type StartResult = { operationId: string } | { busy: Busy }`, `type RecoverResult = StartResult | { error: 'no-recovery' } | { error: 'bad-code'; burned: boolean }`, `interface OperationView extends Operation { log: string[]; recovery: { backup: string; preRestore: string | null } | null }`, `interface AgentDeps`, `class BackupAgent { init(); close(); idle(); startBackup(requestedBy); startRestore(name, requestedBy); recover(code, target: 'same' | 'pre-restore'); operation(): Promise<OperationView | null> }`.

Поведение движка, которое закрепляют тесты:
- **Занятость.** `start` синхронно ставит `running` до первого `await`, поэтому второй одновременный запрос получает `busy`. Если `flock` занят чужим процессом (ручной `now`), ответ — `{ busy: { type: 'backup', startedAt: null } }`.
- **Состояние «требуется восстановление».** Пока оно есть, `startBackup` и `startRestore` отвечают `{ busy: { type: 'restore', startedAt } }`: cron не снимет копию полузаменённой базы и не вытеснит ротацией исправные копии. Выйти из состояния можно только через `recover` или `restore.sh`.
- **Флаг.** `syncFlag(force, strict)` ставит запись в `flagChain`; нужный флаг вычисляется при выполнении:
  - есть идущее восстановление на фазах 3–7 или состояние «требуется восстановление» → `setFlag`;
  - иначе при `force` или если флаг мог остаться (`flagMaybeSet`) → `clearFlag`.

  Таймер (`reassertMs`) вызывает `syncFlag(false)`. Ошибки таймера только пишутся в журнал (не чаще раза в 30 с). Переходы в `maintenance` и далее вызывают `syncFlag(true, true)`: если флаг не записан, восстановление прерывается до замены базы.
- **Код.** `printCode` (в `main.ts` это `console.log('КОД ВОССТАНОВЛЕНИЯ: …')`) вызывается после записи `state.json` и никогда не пишет в журнал операции. При старте с непустым `recovery` код заменяется новым: прежний мог остаться только в журнале прошлого контейнера.
- **Восстановление по коду.** `recovery` в `GET /operation` заполнено, только если операция не идёт (`status !== 'running'`). Повтор по коду сохраняет исходную пару `{ backup, preRestore }` в `recoveryOf`/`preRestore`, и при новом сбое форма предлагает те же две цели.

- [ ] **Step 1: Падающие тесты**

`apps/backup-agent/src/state.test.ts`:

```ts
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  emptyState,
  fileStateStore,
  resolveExternally,
  RESOLVED_EXTERNALLY,
  type AgentState,
  type Operation,
} from './state';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'state-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const op = (over: Partial<Operation> = {}): Operation => ({
  id: 'op1',
  type: 'restore',
  requestedBy: 'admin',
  backup: '2026-10-08T03-00-00Z',
  preRestore: null,
  recoveryOf: null,
  maintenanceStartedAt: null,
  phase: 'verify',
  status: 'running',
  startedAt: '2026-10-08T10:00:00.000Z',
  finishedAt: null,
  error: null,
  ...over,
});

describe('fileStateStore', () => {
  it('нет файла — пустое состояние; запись и чтение; временный файл не остаётся', async () => {
    const store = fileStateStore(join(dir, '.op'));
    expect(await store.read()).toEqual(emptyState());
    const s: AgentState = { operation: op(), recovery: null };
    await store.write(s);
    expect(await store.read()).toEqual(s);
    expect(await readdir(join(dir, '.op'))).toEqual(['state.json']);
  });

  it('записи идут по очереди: последняя побеждает, читатель никогда не видит обрезанный JSON', async () => {
    const store = fileStateStore(dir);
    const writes = Array.from({ length: 30 }, (_, i) =>
      store.write({ operation: op({ id: `op${i}`, error: 'x'.repeat(5000) }), recovery: null }),
    );
    const reads = Array.from({ length: 30 }, () => store.read().catch(() => emptyState()));
    await Promise.all(writes);
    for (const r of await Promise.all(reads)) expect(r.operation === null || r.operation.id.startsWith('op')).toBe(true);
    expect((await store.read()).operation?.id).toBe('op29');
  });
});

describe('resolveExternally (scripts/restore.sh)', () => {
  it('незавершённое восстановление и «требуется восстановление» → failed (resolved externally)', async () => {
    const store = fileStateStore(dir);
    await store.write({
      operation: op({ phase: 'storage', status: 'failed', error: 'сбой' }),
      recovery: {
        codeHash: 'h'.repeat(64),
        attempts: 1,
        backup: '2026-10-08T03-00-00Z',
        preRestore: 'pre-restore-2026-10-08T10-00-00Z',
        phase: 'storage',
        startedAt: '2026-10-08T10:00:05.000Z',
      },
    });
    expect(await resolveExternally(store, new Date('2026-10-08T12:00:00Z'))).toBe(true);
    const s = await store.read();
    expect(s.recovery).toBeNull();
    expect(s.operation).toMatchObject({ status: 'failed', error: RESOLVED_EXTERNALLY });
  });

  it('идущая операция (агент остановлен посреди) → failed с временем окончания', async () => {
    const store = fileStateStore(dir);
    await store.write({ operation: op({ phase: 'db' }), recovery: null });
    expect(await resolveExternally(store, new Date('2026-10-08T12:00:00Z'))).toBe(true);
    expect((await store.read()).operation).toMatchObject({
      status: 'failed',
      error: RESOLVED_EXTERNALLY,
      finishedAt: '2026-10-08T12:00:00.000Z',
    });
  });

  it('нечего отмечать — файл не меняется', async () => {
    const store = fileStateStore(dir);
    const s: AgentState = { operation: op({ status: 'succeeded', phase: 'done' }), recovery: null };
    await store.write(s);
    const before = await readFile(join(dir, 'state.json'), 'utf8');
    expect(await resolveExternally(store)).toBe(false);
    expect(await readFile(join(dir, 'state.json'), 'utf8')).toBe(before);
  });

  it('повреждённый state.json заменяется пустым состоянием', async () => {
    await writeFile(join(dir, 'state.json'), '{"operation":');
    const store = fileStateStore(dir);
    expect(await resolveExternally(store)).toBe(true);
    expect(await store.read()).toEqual(emptyState());
  });
});
```

`apps/backup-agent/src/oplog.test.ts`:

```ts
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fileOpLogs } from './oplog';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'oplog-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('fileOpLogs', () => {
  it('пишет строки в <id>.log, tail отдаёт последние 500', async () => {
    const logs = fileOpLogs(dir);
    const log = await logs.open('a1');
    for (let i = 1; i <= 600; i++) log.write(`строка ${i}`);
    await log.close();
    const tail = await logs.tail('a1');
    expect(tail).toHaveLength(500);
    expect(tail[0]).toBe('строка 101');
    expect(tail.at(-1)).toBe('строка 600');
  });

  it('неизвестная операция — пустой журнал', async () => {
    expect(await fileOpLogs(dir).tail('нет')).toEqual([]);
  });

  it('хранятся последние 20 журналов; state.json и прочие файлы не трогаются', async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'state.json'), '{}');
    for (let i = 0; i < 22; i++) {
      const f = join(dir, `old${String(i).padStart(2, '0')}.log`);
      await writeFile(f, 'x\n');
      const t = new Date(Date.UTC(2026, 0, 1, 0, i));
      await utimes(f, t, t);
    }
    const log = await fileOpLogs(dir).open('new');
    await log.close();
    const files = (await readdir(dir)).sort();
    expect(files.filter((f) => f.endsWith('.log'))).toHaveLength(20);
    expect(files).toContain('new.log');
    expect(files).toContain('state.json');
    expect(files).not.toContain('old00.log');
    expect(files).not.toContain('old01.log');
    expect(files).not.toContain('old02.log');
  });
});
```

`apps/backup-agent/src/lock.test.ts` (`flock` есть на Linux в CI и в образе; на macOS тесты пропускаются):

```ts
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flockFile, FLOCK_HOLDER_SCRIPT, LOCK_BUSY_EXIT } from './lock';

const hasFlock = spawnSync('sh', ['-c', 'command -v flock']).status === 0;
/** Как `entrypoint.sh now`: тот же файл, тот же код 75. */
const shellTry = (path: string) =>
  spawnSync('sh', ['-c', 'exec 9>>"$1"; flock -n 9 || exit 75', 'sh', path]).status;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'lock-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe.skipIf(!hasFlock)('flockFile', () => {
  it('второй захват — null; после освобождения замок свободен', async () => {
    const lock = flockFile(join(dir, '.op.lock'));
    const release = await lock.tryAcquire();
    expect(release).not.toBeNull();
    expect(await lock.tryAcquire()).toBeNull();
    await release!();
    const again = await lock.tryAcquire();
    expect(again).not.toBeNull();
    await again!();
  });

  it('замок держит и shell-скрипт через тот же файл (entrypoint.sh now)', async () => {
    const path = join(dir, '.op.lock');
    const release = await flockFile(path).tryAcquire();
    expect(shellTry(path)).toBe(LOCK_BUSY_EXIT);
    await release!();
    expect(shellTry(path)).toBe(0);
  });

  it('замок снимается, когда умер процесс-владелец (stdin держателя закрылся)', async () => {
    const path = join(dir, '.op.lock');
    // Отдельный node берёт замок тем же держателем и завершается, не отпуская его.
    const child = spawnSync(process.execPath, [
      '-e',
      `const c = require('node:child_process').spawn('sh', ['-c', ${JSON.stringify(FLOCK_HOLDER_SCRIPT)}, 'sh', ${JSON.stringify(path)}], { stdio: ['pipe', 'pipe', 'inherit'] });
       c.stdout.once('data', () => process.exit(0));`,
    ]);
    expect(child.status).toBe(0);
    let status = shellTry(path);
    for (let i = 0; i < 40 && status !== 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
      status = shellTry(path);
    }
    expect(status).toBe(0);
  });
});
```

`apps/backup-agent/src/run.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createRedactor } from './redact';
import { childEnv, run } from './run';

describe('run', () => {
  it('строки stdout и stderr идут в out через фильтр секретов; код 0 — успех', async () => {
    const lines: string[] = [];
    const env = { PATH: process.env.PATH, PGPASSWORD: 'pg-pass-123' };
    await run('sh', ['-c', 'echo начало; echo "пароль $PGPASSWORD" >&2'], {
      env,
      out: (l) => lines.push(l),
      redact: createRedactor(env),
    });
    expect(lines.sort()).toEqual(['начало', 'пароль ***'].sort());
  });

  it('ненулевой код — ошибка с последней непустой строкой вывода (без секретов)', async () => {
    const env = { PATH: process.env.PATH, S3_SECRET_ACCESS_KEY: 'secretkey' };
    await expect(
      run('sh', ['-c', 'echo "нет доступа: secretkey" >&2; exit 3'], {
        env,
        out: () => {},
        redact: createRedactor(env),
      }),
    ).rejects.toThrow('sh: нет доступа: ***');
  });

  it('без вывода — код возврата в сообщении', async () => {
    await expect(
      run('sh', ['-c', 'exit 4'], { env: { PATH: process.env.PATH }, out: () => {}, redact: (s) => s }),
    ).rejects.toThrow('sh: код 4');
  });
});

describe('childEnv', () => {
  it('без токена агента и REDIS_URL; умолчания PG* как в backup.sh; extra перекрывает', () => {
    const env = childEnv(
      { BACKUP_AGENT_TOKEN: 't'.repeat(32), REDIS_URL: 'redis://:p@r', PGPASSWORD: 'x', PGHOST: 'db' },
      { BACKUP_NAME: 'pre-restore-2026-10-08T10-00-00Z' },
    );
    expect(env).not.toHaveProperty('BACKUP_AGENT_TOKEN');
    expect(env).not.toHaveProperty('REDIS_URL');
    expect(env).toMatchObject({
      PGHOST: 'db',
      PGUSER: 'app',
      PGDATABASE: 'app',
      PGPASSWORD: 'x',
      BACKUP_NAME: 'pre-restore-2026-10-08T10-00-00Z',
    });
  });
});
```

`apps/backup-agent/src/agent.test.ts`:

```ts
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BackupAgent, type MaintenanceFlag, type Steps } from './agent';
import type { FileLock } from './lock';
import { fileOpLogs } from './oplog';
import { hashCode } from './recovery';
import { fileStateStore, type AgentState, type Operation, type StateStore } from './state';

const B = '2026-10-08T03-00-00Z';
const PRE = 'pre-restore-2026-10-08T10-00-00Z';
const CODE_RE = /^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/;

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}

const freeLock = (): FileLock => ({ tryAcquire: async () => async () => {} });
const heldLock = (): FileLock => ({ tryAcquire: async () => null });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Flag = MaintenanceFlag | null;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function setup(
  opts: { steps?: Partial<Steps>; lock?: FileLock; state?: AgentState; reassertMs?: number } = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'agent-'));
  const store = fileStateStore(dir);
  if (opts.state) await store.write(opts.state);
  const writes: AgentState[] = [];
  const spyStore: StateStore = {
    read: () => store.read(),
    write: async (s) => {
      writes.push(structuredClone(s));
      await store.write(s);
    },
  };
  const calls: string[] = [];
  const flags: Flag[] = [];
  const steps: Steps = {
    backup: async () => void calls.push('backup'),
    verify: async (b) => void calls.push(`verify ${b}`),
    preBackup: async () => {
      calls.push('pre-backup');
      return PRE;
    },
    terminateApi: async () => void calls.push('terminate'),
    restoreDb: async (b) => void calls.push(`db ${b}`),
    migrate: async () => void calls.push('migrate'),
    restoreStorage: async (b) => void calls.push(`storage ${b}`),
    flushRedis: async () => void calls.push('redis'),
    setFlag: async (f) => void flags.push(f),
    clearFlag: async () => void flags.push(null),
    ...opts.steps,
  };
  const codes: string[] = [];
  const agent = new BackupAgent({
    steps,
    store: spyStore,
    lock: opts.lock ?? freeLock(),
    logs: fileOpLogs(join(dir, 'logs')),
    printCode: (c) => codes.push(c),
    log: () => {},
    reassertMs: opts.reassertMs ?? 60_000,
  });
  await agent.init();
  cleanups.push(async () => {
    agent.close();
    await agent.idle();
    await rm(dir, { recursive: true, force: true });
  });
  return { agent, dir, store, writes, calls, flags, codes };
}

const restoreOp = (over: Partial<Operation>): Operation => ({
  id: 'old',
  type: 'restore',
  requestedBy: 'admin',
  backup: B,
  preRestore: PRE,
  recoveryOf: null,
  maintenanceStartedAt: '2026-10-08T10:00:05.000Z',
  phase: 'verify',
  status: 'running',
  startedAt: '2026-10-08T10:00:00.000Z',
  finishedAt: null,
  error: null,
  ...over,
});

const recoveryState = (code: string) => ({
  codeHash: hashCode(code),
  attempts: 0,
  backup: B,
  preRestore: PRE,
  phase: 'storage' as const,
  startedAt: '2026-10-08T10:00:05.000Z',
});

describe('BackupAgent: бэкап', () => {
  it('успех: операция succeeded, кто запустил — в операции и журнале', async () => {
    const t = await setup();
    const r = await t.agent.startBackup('admin');
    expect(r).toHaveProperty('operationId');
    await t.agent.idle();
    const op = await t.agent.operation();
    expect(op).toMatchObject({ type: 'backup', requestedBy: 'admin', status: 'succeeded', recovery: null });
    expect(op!.log.join('\n')).toContain('запустил admin');
    expect(t.calls).toEqual(['backup']);
  });

  it('сбой скрипта: failed с текстом ошибки', async () => {
    const t = await setup({ steps: { backup: async () => Promise.reject(new Error('backup.sh: ошибка (pg_dump)')) } });
    await t.agent.startBackup('cron');
    await t.agent.idle();
    expect(await t.agent.operation()).toMatchObject({ status: 'failed', error: 'backup.sh: ошибка (pg_dump)' });
  });

  it('одновременные запросы: второй получает busy с типом и временем первой операции', async () => {
    const gate = deferred();
    const t = await setup({ steps: { backup: () => gate.promise } });
    const [a, b] = await Promise.all([t.agent.startBackup('admin'), t.agent.startRestore(B, 'admin')]);
    expect(a).toHaveProperty('operationId');
    expect(b).toEqual({ busy: { type: 'backup', startedAt: expect.any(String) } });
    gate.resolve();
    await t.agent.idle();
  });

  it('flock занят другим процессом (ручной now) — busy без времени', async () => {
    const t = await setup({ lock: heldLock() });
    expect(await t.agent.startBackup('cron')).toEqual({ busy: { type: 'backup', startedAt: null } });
    expect(await t.agent.operation()).toBeNull();
  });
});

describe('BackupAgent: восстановление', () => {
  it('успех: фазы по порядку, каждая записана в state.json; флаг на фазах 3–7 и снят в конце', async () => {
    const t = await setup();
    await t.agent.startRestore(B, 'admin');
    await t.agent.idle();
    const phases = t.writes.map((s) => s.operation?.phase).filter((p, i, a) => p && p !== a[i - 1]);
    expect(phases).toEqual(['verify', 'pre-backup', 'maintenance', 'db', 'migrate', 'storage', 'redis', 'done']);
    expect(t.calls).toEqual([`verify ${B}`, 'pre-backup', 'terminate', `db ${B}`, 'migrate', `storage ${B}`, 'redis']);
    expect(t.flags.map((f) => f?.phase ?? null)).toEqual([null, 'maintenance', 'db', 'migrate', 'storage', 'redis', null]);
    expect(t.flags[1]).toEqual({ phase: 'maintenance', startedAt: expect.any(String), backup: B });
    const op = await t.agent.operation();
    expect(op).toMatchObject({ status: 'succeeded', phase: 'done', preRestore: PRE, recovery: null });
    expect(t.codes).toEqual([]);
  });

  it('сбой verify: ничего не меняется, флаг не ставится, pre-backup не делается', async () => {
    const t = await setup({ steps: { verify: async () => Promise.reject(new Error('бэкап создан более новой версией приложения')) } });
    await t.agent.startRestore(B, 'admin');
    await t.agent.idle();
    expect(await t.agent.operation()).toMatchObject({ status: 'failed', phase: 'verify', error: 'бэкап создан более новой версией приложения', recovery: null });
    expect(t.calls).toEqual([]);
    expect(t.flags.filter(Boolean)).toEqual([]);
  });

  it('сбой pre-backup: восстановление отменено до обслуживания', async () => {
    const t = await setup({ steps: { preBackup: async () => Promise.reject(new Error('backup.sh: код 1')) } });
    await t.agent.startRestore(B, 'admin');
    await t.agent.idle();
    expect(await t.agent.operation()).toMatchObject({ status: 'failed', phase: 'pre-backup', recovery: null });
    expect(t.flags.filter(Boolean)).toEqual([]);
  });

  it('флаг не записался (Redis недоступен) — отмена до замены базы, флаг снимается', async () => {
    const t = await setup({ steps: { setFlag: async () => Promise.reject(new Error('Redis недоступен')) } });
    await t.agent.startRestore(B, 'admin');
    await t.agent.idle();
    expect(await t.agent.operation()).toMatchObject({ status: 'failed', phase: 'maintenance', recovery: null });
    expect(t.calls).not.toContain(`db ${B}`);
    expect(t.flags.at(-1)).toBeNull();
    expect(t.codes).toEqual([]);
  });

  it('сбой на фазе storage: флаг остаётся, «требуется восстановление», код напечатан', async () => {
    const t = await setup({ steps: { restoreStorage: async () => Promise.reject(new Error('rclone: нет связи')) } });
    await t.agent.startRestore(B, 'admin');
    await t.agent.idle();
    expect(await t.agent.operation()).toMatchObject({
      status: 'failed',
      phase: 'storage',
      error: 'rclone: нет связи',
      recovery: { backup: B, preRestore: PRE },
    });
    expect(t.codes).toHaveLength(1);
    expect(t.codes[0]).toMatch(CODE_RE);
    expect(t.flags.at(-1)).toMatchObject({ phase: 'storage', backup: B });
  });

  it('код только в stdout: не в журнале операции и не в state.json (там sha256)', async () => {
    const t = await setup({ steps: { migrate: async () => Promise.reject(new Error('миграция')) } });
    await t.agent.startRestore(B, 'admin');
    await t.agent.idle();
    const code = t.codes[0]!;
    const op = await t.agent.operation();
    expect(op!.log.join('\n')).not.toContain(code);
    const state = await readFile(join(t.dir, 'state.json'), 'utf8');
    expect(state).not.toContain(code);
    expect(state).not.toContain(code.replaceAll('-', ''));
    expect(state).toContain(hashCode(code));
  });

  it('в состоянии «требуется восстановление» бэкап и восстановление отклоняются', async () => {
    const t = await setup({ state: { operation: restoreOp({ status: 'failed', phase: 'storage' }), recovery: recoveryState('AAAA-BBBB-CCCC') } });
    expect(await t.agent.startBackup('cron')).toEqual({ busy: { type: 'restore', startedAt: '2026-10-08T10:00:05.000Z' } });
    expect(await t.agent.startRestore(B, 'admin')).toEqual({ busy: { type: 'restore', startedAt: '2026-10-08T10:00:05.000Z' } });
    expect(t.calls).toEqual([]);
  });
});

describe('BackupAgent: повтор по коду', () => {
  /** Восстановление, упавшее на фазе storage; ctl управляет следующими запусками шагов. */
  async function failed() {
    const ctl = { failStorage: true, redisGate: null as Promise<void> | null };
    const t = await setup({
      steps: {
        restoreStorage: async (b) => {
          t.calls.push(`storage ${b}`);
          if (ctl.failStorage) throw new Error('rclone: нет связи');
        },
        flushRedis: async () => {
          t.calls.push('redis');
          if (ctl.redisGate) await ctl.redisGate;
        },
      },
    });
    await t.agent.startRestore(B, 'admin');
    await t.agent.idle();
    return { ...t, ctl };
  }

  it('нет состояния «требуется восстановление» — no-recovery', async () => {
    const t = await setup();
    expect(await t.agent.recover('AAAA-BBBB-CCCC', 'same')).toEqual({ error: 'no-recovery' });
  });

  it('неверный код — bad-code; после 5 неверных код сгорает и печатается новый', async () => {
    const t = await failed();
    const first = t.codes[0]!;
    for (let i = 1; i <= 4; i++)
      expect(await t.agent.recover('AAAA-AAAA-AAAA', 'same')).toEqual({ error: 'bad-code', burned: false });
    expect(await t.agent.recover('AAAA-AAAA-AAAA', 'same')).toEqual({ error: 'bad-code', burned: true });
    expect(t.codes).toHaveLength(2);
    expect(t.codes[1]).not.toBe(first);
    expect(await t.agent.recover(first, 'same')).toEqual({ error: 'bad-code', burned: false });
  });

  it('верный код, цель same: с фазы maintenance без verify и pre-backup; успех снимает флаг и состояние', async () => {
    const t = await failed();
    t.ctl.failStorage = false;
    t.calls.length = 0;
    const r = await t.agent.recover(t.codes[0]!.toLowerCase(), 'same');
    expect(r).toHaveProperty('operationId');
    await t.agent.idle();
    expect(t.calls).toEqual(['terminate', `db ${B}`, 'migrate', `storage ${B}`, 'redis']);
    expect(await t.agent.operation()).toMatchObject({ status: 'succeeded', requestedBy: 'recovery-code', recovery: null });
    expect(t.flags.at(-1)).toBeNull();
    expect(await t.agent.startBackup('admin')).toHaveProperty('operationId');
    await t.agent.idle();
  });

  it('цель pre-restore восстанавливает бэкап до восстановления', async () => {
    const t = await failed();
    t.ctl.failStorage = false;
    t.calls.length = 0;
    await t.agent.recover(t.codes[0]!, 'pre-restore');
    await t.agent.idle();
    expect(t.calls).toContain(`db ${PRE}`);
    expect(await t.agent.operation()).toMatchObject({ status: 'succeeded', backup: PRE });
  });

  it('повтор снова упал — новый код, цели прежние', async () => {
    const t = await failed();
    await t.agent.recover(t.codes[0]!, 'pre-restore');
    await t.agent.idle();
    expect(t.codes).toHaveLength(2);
    expect(t.codes[1]).not.toBe(t.codes[0]);
    expect((await t.agent.operation())!.recovery).toEqual({ backup: B, preRestore: PRE });
  });

  it('пока идёт повтор, recovery в операции не показывается, а новый повтор — busy', async () => {
    const gate = deferred();
    const t = await failed();
    t.ctl.failStorage = false;
    t.ctl.redisGate = gate.promise;
    const code = t.codes[0]!;
    await t.agent.recover(code, 'same');
    await sleep(20);
    expect((await t.agent.operation())!.recovery).toBeNull();
    expect(await t.agent.recover(code, 'same')).toMatchObject({ busy: { type: 'restore' } });
    gate.resolve();
    await t.agent.idle();
  });
});

describe('BackupAgent: рестарт и флаг', () => {
  it('рестарт на фазе pre-backup: операция failed, флаг снят, кода нет', async () => {
    const t = await setup({ state: { operation: restoreOp({ phase: 'pre-backup' }), recovery: null } });
    expect(await t.agent.operation()).toMatchObject({ status: 'failed', error: 'прервано перезапуском агента', recovery: null });
    expect(t.flags).toEqual([null]);
    expect(t.codes).toEqual([]);
  });

  it('рестарт на фазе migrate: требуется восстановление, флаг на месте, новый код', async () => {
    const t = await setup({ state: { operation: restoreOp({ phase: 'migrate' }), recovery: null } });
    expect(await t.agent.operation()).toMatchObject({ status: 'failed', recovery: { backup: B, preRestore: PRE } });
    expect(t.codes).toHaveLength(1);
    expect(t.flags).toEqual([{ phase: 'migrate', startedAt: '2026-10-08T10:00:05.000Z', backup: B }]);
  });

  it('рестарт посреди бэкапа: failed', async () => {
    const t = await setup({ state: { operation: restoreOp({ type: 'backup', phase: 'backup', backup: null }), recovery: null } });
    expect(await t.agent.operation()).toMatchObject({ status: 'failed', error: 'прервано перезапуском агента' });
    expect(t.flags).toEqual([null]);
  });

  it('рестарт в состоянии «требуется восстановление»: прежний код заменён новым', async () => {
    const t = await setup({ state: { operation: restoreOp({ status: 'failed', phase: 'storage' }), recovery: recoveryState('AAAA-BBBB-CCCC') } });
    expect(t.codes).toHaveLength(1);
    expect(await t.agent.recover('AAAA-BBBB-CCCC', 'same')).toEqual({ error: 'bad-code', burned: false });
  });

  it('resolved externally: агент не возвращает флаг', async () => {
    const t = await setup({ state: { operation: restoreOp({ status: 'failed', phase: 'storage', error: 'resolved externally: scripts/restore.sh' }), recovery: null }, reassertMs: 20 });
    await sleep(100);
    expect(t.flags.filter(Boolean)).toEqual([]);
  });

  it('флаг повторяется каждые reassertMs, пока требуется восстановление', async () => {
    const t = await setup({ state: { operation: restoreOp({ status: 'failed', phase: 'storage' }), recovery: recoveryState('AAAA-BBBB-CCCC') }, reassertMs: 20 });
    await sleep(150);
    expect(t.flags.filter((f) => f?.phase === 'storage').length).toBeGreaterThanOrEqual(4);
  });

  it('повтор флага не возвращает его после снятия', async () => {
    // Медленный SET: повтор таймера ещё в очереди, когда восстановление снимает флаг.
    let slowSets = 0;
    const flagsSeen: Flag[] = [];
    const t = await setup({
      reassertMs: 5,
      state: { operation: restoreOp({ status: 'failed', phase: 'storage' }), recovery: recoveryState('AAAA-BBBB-CCCC') },
      steps: {
        setFlag: async (f) => {
          slowSets++;
          await sleep(3);
          flagsSeen.push(f);
        },
        clearFlag: async () => void flagsSeen.push(null),
      },
    });
    await t.agent.recover(t.codes[0]!, 'same');
    await t.agent.idle();
    await sleep(60);
    expect(slowSets).toBeGreaterThan(0);
    expect(flagsSeen.at(-1)).toBeNull();
    const after = flagsSeen.length;
    await sleep(60);
    expect(flagsSeen.slice(after).every((f) => f === null)).toBe(true);
  });

  it('DEL не прошёл — таймер снимает флаг позже', async () => {
    let failDel = true;
    const dels: string[] = [];
    const t = await setup({
      reassertMs: 20,
      steps: {
        clearFlag: async () => {
          dels.push(failDel ? 'fail' : 'ok');
          if (failDel) throw new Error('Redis недоступен');
        },
        terminateApi: async () => Promise.reject(new Error('postgres недоступен')),
      },
    });
    dels.length = 0;
    await t.agent.startRestore(B, 'admin');
    await t.agent.idle();
    expect(dels).toContain('fail');
    failDel = false;
    await sleep(80);
    expect(dels.at(-1)).toBe('ok');
    const n = dels.length;
    await sleep(80);
    expect(dels.length).toBe(n);
  });
});
```

- [ ] **Step 2: Запуск — должно упасть**

Run: `source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null && pnpm --filter @carbone-reports/backup-agent test`
Expected: FAIL — `Failed to resolve import "./state"`, `"./oplog"`, `"./lock"`, `"./run"`, `"./agent"`.

- [ ] **Step 3: `state.ts`, `oplog.ts`, `lock.ts`, `run.ts`**

`apps/backup-agent/src/state.ts`:

```ts
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const RESTORE_PHASES = [
  'verify',
  'pre-backup',
  'maintenance',
  'db',
  'migrate',
  'storage',
  'redis',
  'done',
] as const;
export type RestorePhase = (typeof RESTORE_PHASES)[number];
export type Phase = RestorePhase | 'backup';
/** Фазы 3–7: пока восстановление на одной из них, флаг cr:maintenance должен стоять. */
export const MAINTENANCE_PHASES: readonly Phase[] = ['maintenance', 'db', 'migrate', 'storage', 'redis'];
/** Фазы 4–7: база уже могла измениться — сбой ведёт в «требуется восстановление». */
export const DB_PHASES: readonly Phase[] = ['db', 'migrate', 'storage', 'redis'];

export interface Operation {
  id: string;
  type: 'backup' | 'restore';
  /** cron | логин | recovery-code */
  requestedBy: string;
  /** Что восстанавливается (для restore). */
  backup: string | null;
  /** pre-restore-* этого восстановления (или исходного, если это повтор по коду). */
  preRestore: string | null;
  /** Повтор по коду: исходный бэкап, из которого восстанавливали. */
  recoveryOf: string | null;
  maintenanceStartedAt: string | null;
  phase: Phase;
  status: 'running' | 'succeeded' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
}

/** «Требуется восстановление» (§26.4). Кода здесь нет — только его sha256. */
export interface RecoveryState {
  codeHash: string;
  attempts: number;
  backup: string;
  preRestore: string | null;
  phase: RestorePhase;
  startedAt: string;
}

export interface AgentState {
  operation: Operation | null;
  recovery: RecoveryState | null;
}

export interface StateStore {
  read(): Promise<AgentState>;
  write(s: AgentState): Promise<void>;
}

export const emptyState = (): AgentState => ({ operation: null, recovery: null });

export const RESOLVED_EXTERNALLY = 'resolved externally: scripts/restore.sh';

/**
 * <dir>/state.json. Запись атомарна: JSON во временный файл рядом и rename — после сбоя на диске
 * либо прежнее, либо новое состояние. Записи одного процесса идут строго по очереди.
 */
export function fileStateStore(dir: string): StateStore {
  const path = join(dir, 'state.json');
  let chain: Promise<unknown> = Promise.resolve();
  return {
    async read() {
      let text: string;
      try {
        text = await readFile(path, 'utf8');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
        throw e;
      }
      return { ...emptyState(), ...(JSON.parse(text) as Partial<AgentState>) };
    },
    write(s) {
      const json = JSON.stringify(s, null, 2);
      const job = chain.then(async () => {
        await mkdir(dir, { recursive: true });
        const tmp = `${path}.tmp`;
        await writeFile(tmp, json);
        await rename(tmp, path);
      });
      chain = job.catch(() => {});
      return job;
    },
  };
}

/**
 * scripts/restore.sh перед запуском агента (§26.4): незавершённая операция и состояние
 * «требуется восстановление» помечаются failed (resolved externally) — агент больше не включает
 * обслуживание. true — состояние изменено.
 */
export async function resolveExternally(store: StateStore, now = new Date()): Promise<boolean> {
  let s: AgentState;
  try {
    s = await store.read();
  } catch {
    await store.write(emptyState());
    return true;
  }
  const op = s.operation;
  if (!(op?.status === 'running' || s.recovery)) return false;
  if (op) {
    op.status = 'failed';
    op.error = RESOLVED_EXTERNALLY;
    op.finishedAt ??= now.toISOString();
  }
  s.recovery = null;
  await store.write(s);
  return true;
}
```

`apps/backup-agent/src/oplog.ts`:

```ts
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface OpLog {
  write(line: string): void;
  close(): Promise<void>;
}

export interface OpLogs {
  open(id: string): Promise<OpLog>;
  tail(id: string): Promise<string[]>;
}

/** Журналы операций /backups/.op/<id>.log (§26.1): хранятся последние keep, отдаётся хвост tailLines строк. */
export function fileOpLogs(dir: string, keep = 20, tailLines = 500): OpLogs {
  return {
    async open(id) {
      await mkdir(dir, { recursive: true });
      const stream = createWriteStream(join(dir, `${id}.log`), { flags: 'a' });
      await once(stream, 'open');
      await prune(dir, keep);
      return {
        write: (line) => void stream.write(`${line}\n`),
        close: () => new Promise<void>((resolve) => stream.end(resolve)),
      };
    },
    async tail(id) {
      let text: string;
      try {
        text = await readFile(join(dir, `${id}.log`), 'utf8');
      } catch {
        return [];
      }
      const lines = text.split('\n');
      if (lines.at(-1) === '') lines.pop();
      return lines.slice(-tailLines);
    },
  };
}

async function prune(dir: string, keep: number): Promise<void> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.log'));
  const dated = await Promise.all(
    files.map(async (f) => ({ f, t: (await stat(join(dir, f))).mtimeMs })),
  );
  dated.sort((a, b) => b.t - a.t || b.f.localeCompare(a.f));
  for (const { f } of dated.slice(keep)) await rm(join(dir, f), { force: true });
}
```

`apps/backup-agent/src/lock.ts`:

```ts
import { spawn } from 'node:child_process';

export type Release = () => Promise<void>;

export interface FileLock {
  /** null — замок занят другим процессом. */
  tryAcquire(): Promise<Release | null>;
}

export const LOCK_BUSY_EXIT = 75;

/**
 * Держатель замка: открывает файл на fd 9, берёт flock без ожидания и живёт, пока открыт его stdin.
 * Агент отпускает замок, закрывая stdin. Если агент умер, pipe закрывается сам: cat завершается,
 * fd закрывается, и замок снимается. Тот же файл и тот же код 75 у `entrypoint.sh now`.
 */
export const FLOCK_HOLDER_SCRIPT = `exec 9>>"$1"; flock -n 9 || exit ${LOCK_BUSY_EXIT}; echo locked; exec cat >/dev/null`;

export function flockFile(path: string): FileLock {
  return {
    tryAcquire: () =>
      new Promise((resolve, reject) => {
        const child = spawn('sh', ['-c', FLOCK_HOLDER_SCRIPT, 'sh', path], {
          stdio: ['pipe', 'pipe', 'inherit'],
        });
        let settled = false;
        const exited = new Promise<void>((r) => child.once('exit', () => r()));
        child.stdout.once('data', () => {
          settled = true;
          resolve(async () => {
            child.stdin.end();
            await exited;
          });
        });
        child.once('error', (e) => {
          if (!settled) {
            settled = true;
            reject(e);
          }
        });
        child.once('exit', (code) => {
          if (settled) return;
          settled = true;
          if (code === LOCK_BUSY_EXIT) resolve(null);
          else reject(new Error(`flock: код ${code}`));
        });
      }),
  };
}
```

`apps/backup-agent/src/run.ts`:

```ts
import { spawn } from 'node:child_process';
import { basename } from 'node:path';
import { createInterface } from 'node:readline';
import type { Redact } from './redact';

export type Out = (line: string) => void;

export interface RunOptions {
  env: NodeJS.ProcessEnv;
  out: Out;
  redact: Redact;
}

export type Runner = (cmd: string, args: string[], o: RunOptions) => Promise<void>;

/**
 * Дочерний процесс: каждая строка stdout и stderr проходит фильтр секретов и уходит в out.
 * Ненулевой код — ошибка с последней непустой строкой вывода (обычно это текст ошибки скрипта).
 */
export const run: Runner = (cmd, args, o) =>
  new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: o.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let last = '';
    const onLine = (raw: string) => {
      const line = o.redact(raw);
      if (line.trim()) last = line.trim();
      o.out(line);
    };
    createInterface({ input: child.stdout }).on('line', onLine);
    createInterface({ input: child.stderr }).on('line', onLine);
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) return resolve();
      const why = last || (signal ? `сигнал ${signal}` : `код ${code}`);
      reject(new Error(`${basename(cmd)}: ${why}`));
    });
  });

/**
 * Окружение скриптов: без токена агента и REDIS_URL (скриптам они не нужны), умолчания PG*
 * — как в backup.sh. extra — переменные для конкретного вызова (BACKUP_NAME, RESTORE_DIR).
 */
export function childEnv(env: NodeJS.ProcessEnv, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const { BACKUP_AGENT_TOKEN: _token, REDIS_URL: _redis, ...rest } = env;
  return { PGHOST: 'postgres', PGUSER: 'app', PGDATABASE: 'app', ...rest, ...extra };
}
```

- [ ] **Step 4: `agent.ts`**

`apps/backup-agent/src/agent.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { FileLock, Release } from './lock';
import type { OpLog, OpLogs } from './oplog';
import { codeMatches, generateCode, hashCode, MAX_ATTEMPTS } from './recovery';
import type { Out } from './run';
import {
  DB_PHASES,
  emptyState,
  MAINTENANCE_PHASES,
  type AgentState,
  type Operation,
  type RestorePhase,
  type StateStore,
} from './state';

/** Значение cr:maintenance (§26.2). */
export interface MaintenanceFlag {
  phase: RestorePhase;
  startedAt: string;
  backup: string;
}

/** Шаги операций; реальные — createSteps (steps.ts), в юнит-тестах — подделки. */
export interface Steps {
  backup(out: Out): Promise<void>;
  verify(backup: string, out: Out): Promise<void>;
  /** Бэкап pre-restore-<время>; возвращает имя каталога. */
  preBackup(out: Out): Promise<string>;
  /** Пауза terminateDelayMs, затем pg_terminate_backend сессий application_name = 'api'. */
  terminateApi(out: Out): Promise<void>;
  restoreDb(backup: string, out: Out): Promise<void>;
  migrate(out: Out): Promise<void>;
  restoreStorage(backup: string, out: Out): Promise<void>;
  flushRedis(out: Out): Promise<void>;
  setFlag(flag: MaintenanceFlag): Promise<void>;
  clearFlag(): Promise<void>;
}

export interface Busy {
  type: 'backup' | 'restore';
  /** null — замок держит другой процесс (ручной `docker compose run backup now`). */
  startedAt: string | null;
}
export type StartResult = { operationId: string } | { busy: Busy };
export type RecoverResult = StartResult | { error: 'no-recovery' } | { error: 'bad-code'; burned: boolean };

export interface OperationView extends Operation {
  log: string[];
  recovery: { backup: string; preRestore: string | null } | null;
}

export interface AgentDeps {
  steps: Steps;
  store: StateStore;
  lock: FileLock;
  logs: OpLogs;
  /** Только stdout контейнера (docker compose logs backup), никогда — журнал операции. */
  printCode(code: string): void;
  /** Журнал агента (stdout). */
  log(line: string): void;
  reassertMs: number;
  now?: () => Date;
  newId?: () => string;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const INTERRUPTED = 'прервано перезапуском агента';

export class BackupAgent {
  private state: AgentState = emptyState();
  private running: { type: 'backup' | 'restore'; startedAt: string } | null = null;
  private current: Promise<void> = Promise.resolve();
  private flagChain: Promise<void> = Promise.resolve();
  /** Флаг мог остаться в Redis (последний SET или неудачный DEL). */
  private flagMaybeSet = true;
  private lastFlagWarn = -Infinity;
  private timer: NodeJS.Timeout | null = null;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly d: AgentDeps) {
    this.now = d.now ?? (() => new Date());
    this.newId = d.newId ?? randomUUID;
  }

  /** Чтение state.json, разбор прерванной операции (§26.2), снятие или возврат флага, таймер повтора. */
  async init(): Promise<void> {
    this.state = await this.d.store.read();
    const op = this.state.operation;
    let code: string | null = null;
    if (op?.status === 'running') {
      this.finish(op, 'failed', INTERRUPTED);
      if (op.type === 'restore' && DB_PHASES.includes(op.phase)) code = this.newRecovery(op);
      await this.save();
    } else if (this.state.recovery) {
      code = this.renewCode();
      await this.save();
      this.d.log('агент перезапущен в состоянии «требуется восстановление»: прежний код заменён');
    }
    if (code) this.d.printCode(code);
    await this.syncFlag(true);
    this.timer = setInterval(() => void this.syncFlag(false), this.d.reassertMs);
    this.timer.unref();
  }

  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Конец текущей операции (тесты, остановка). */
  idle(): Promise<void> {
    return this.current;
  }

  startBackup(requestedBy: string): Promise<StartResult> {
    const blocked = this.recoveryBusy();
    if (blocked) return Promise.resolve(blocked);
    return this.start('backup', requestedBy, null, {}, (op, out) => this.runBackup(op, out));
  }

  startRestore(backup: string, requestedBy: string): Promise<StartResult> {
    const blocked = this.recoveryBusy();
    if (blocked) return Promise.resolve(blocked);
    return this.start('restore', requestedBy, backup, {}, (op, out) => this.runRestore(op, out, true));
  }

  async recover(code: string, target: 'same' | 'pre-restore'): Promise<RecoverResult> {
    if (this.running) return { busy: { ...this.running } };
    const rec = this.state.recovery;
    if (!rec) return { error: 'no-recovery' };
    if (!codeMatches(code, rec.codeHash)) {
      rec.attempts += 1;
      const burned = rec.attempts >= MAX_ATTEMPTS;
      const fresh = burned ? this.renewCode() : null;
      await this.save();
      if (fresh) {
        this.d.log(`${MAX_ATTEMPTS} неверных попыток: код восстановления заменён`);
        this.d.printCode(fresh);
      }
      return { error: 'bad-code', burned };
    }
    const backup = target === 'same' ? rec.backup : rec.preRestore;
    if (!backup) return { error: 'no-recovery' };
    return this.start(
      'restore',
      'recovery-code',
      backup,
      { recoveryOf: rec.backup, preRestore: rec.preRestore },
      (op, out) => this.runRestore(op, out, false),
    );
  }

  async operation(): Promise<OperationView | null> {
    const op = this.state.operation;
    if (!op) return null;
    const rec = this.state.recovery;
    return {
      ...op,
      log: await this.d.logs.tail(op.id),
      recovery:
        op.status !== 'running' && rec ? { backup: rec.backup, preRestore: rec.preRestore } : null,
    };
  }

  private recoveryBusy(): { busy: Busy } | null {
    const rec = this.state.recovery;
    return rec ? { busy: { type: 'restore', startedAt: rec.startedAt } } : null;
  }

  private async start(
    type: 'backup' | 'restore',
    requestedBy: string,
    backup: string | null,
    extra: Partial<Operation>,
    body: (op: Operation, out: Out) => Promise<void>,
  ): Promise<StartResult> {
    if (this.running) return { busy: { ...this.running } };
    const startedAt = this.now().toISOString();
    // До первого await: одновременный второй запрос увидит занятость.
    this.running = { type, startedAt };
    let release: Release | null;
    try {
      release = await this.d.lock.tryAcquire();
    } catch (e) {
      this.running = null;
      throw e;
    }
    if (!release) {
      this.running = null;
      return { busy: { type: 'backup', startedAt: null } };
    }
    const op: Operation = {
      id: this.newId(),
      type,
      requestedBy,
      backup,
      preRestore: null,
      recoveryOf: null,
      maintenanceStartedAt: null,
      phase: type === 'backup' ? 'backup' : 'verify',
      status: 'running',
      startedAt,
      finishedAt: null,
      error: null,
      ...extra,
    };
    let log: OpLog;
    try {
      this.state.operation = op;
      await this.save();
      log = await this.d.logs.open(op.id);
    } catch (e) {
      this.running = null;
      await release();
      throw e;
    }
    const out: Out = (line) => {
      log.write(line);
      this.d.log(line);
    };
    out(
      `операция ${op.id}: ${type === 'backup' ? 'бэкап' : `восстановление из ${backup}`}, запустил ${requestedBy}`,
    );
    const held = release;
    this.current = body(op, out)
      .catch((e) => this.d.log(`внутренняя ошибка операции: ${errorText(e)}`))
      .finally(async () => {
        await log.close();
        await held();
        this.running = null;
      });
    return { operationId: op.id };
  }

  private async runBackup(op: Operation, out: Out): Promise<void> {
    try {
      await this.d.steps.backup(out);
      this.finish(op, 'succeeded');
      out('бэкап завершён');
    } catch (e) {
      this.finish(op, 'failed', errorText(e));
      out(`ошибка: ${errorText(e)}`);
    }
    await this.save();
  }

  /** full = false — повтор по коду: с фазы maintenance, без verify и pre-backup (§26.4). */
  private async runRestore(op: Operation, out: Out, full: boolean): Promise<void> {
    const s = this.d.steps;
    const backup = op.backup!;
    try {
      if (full) {
        await this.phase(op, 'verify', out);
        await s.verify(backup, out);
        await this.phase(op, 'pre-backup', out);
        op.preRestore = await s.preBackup(out);
        await this.save();
      }
      op.maintenanceStartedAt = this.now().toISOString();
      await this.phase(op, 'maintenance', out);
      await this.syncFlag(true, true);
      await s.terminateApi(out);
      const rest: [RestorePhase, () => Promise<void>][] = [
        ['db', () => s.restoreDb(backup, out)],
        ['migrate', () => s.migrate(out)],
        ['storage', () => s.restoreStorage(backup, out)],
        ['redis', () => s.flushRedis(out)],
      ];
      for (const [phase, step] of rest) {
        await this.phase(op, phase, out);
        await this.syncFlag(true, true);
        await step();
      }
      op.phase = 'done';
      this.finish(op, 'succeeded');
      this.state.recovery = null;
      await this.save();
      out('восстановление завершено');
      await this.syncFlag(true);
    } catch (e) {
      const failedAt = op.phase;
      this.finish(op, 'failed', errorText(e));
      out(`ошибка на этапе ${failedAt}: ${errorText(e)}`);
      const code = DB_PHASES.includes(failedAt) ? this.newRecovery(op) : null;
      await this.save();
      if (code) {
        out(
          'восстановление не завершено: база частично заменена; код восстановления — в журнале контейнера (docker compose logs backup)',
        );
        this.d.printCode(code);
      }
      // Фазы 1–3: флаг снимается; 4–7: остаётся (состояние «требуется восстановление»).
      await this.syncFlag(true);
    }
  }

  private async phase(op: Operation, phase: RestorePhase, out: Out): Promise<void> {
    op.phase = phase;
    await this.save();
    out(`этап: ${phase}`);
  }

  private finish(op: Operation, status: 'succeeded' | 'failed', error: string | null = null): void {
    op.status = status;
    op.error = error;
    op.finishedAt = this.now().toISOString();
  }

  /** Новое состояние «требуется восстановление»; возвращает код (печатается после записи state.json). */
  private newRecovery(op: Operation): string {
    const code = generateCode();
    this.state.recovery = {
      codeHash: hashCode(code),
      attempts: 0,
      backup: op.recoveryOf ?? op.backup!,
      preRestore: op.preRestore,
      phase: op.phase as RestorePhase,
      startedAt: op.maintenanceStartedAt ?? op.startedAt,
    };
    return code;
  }

  private renewCode(): string {
    const code = generateCode();
    this.state.recovery!.codeHash = hashCode(code);
    this.state.recovery!.attempts = 0;
    return code;
  }

  private save(): Promise<void> {
    return this.d.store.write(this.state);
  }

  /** Каким должен быть флаг сейчас (§26.2: фазы 3–7 или «требуется восстановление»). */
  private desiredFlag(): MaintenanceFlag | null {
    const op = this.state.operation;
    if (op?.type === 'restore' && op.status === 'running' && MAINTENANCE_PHASES.includes(op.phase))
      return {
        phase: op.phase as RestorePhase,
        startedAt: op.maintenanceStartedAt ?? op.startedAt,
        backup: op.backup!,
      };
    const rec = this.state.recovery;
    return rec ? { phase: rec.phase, startedAt: rec.startedAt, backup: rec.backup } : null;
  }

  /**
   * Все записи флага — по очереди, значение вычисляется в момент записи: повтор, поставленный
   * в очередь до снятия флага, его не вернёт. strict — ошибку отдать вызывающему (переход фазы).
   */
  private syncFlag(force: boolean, strict = false): Promise<void> {
    const job = this.flagChain.then(async () => {
      const flag = this.desiredFlag();
      try {
        if (flag) {
          this.flagMaybeSet = true;
          await this.d.steps.setFlag(flag);
        } else if (force || this.flagMaybeSet) {
          await this.d.steps.clearFlag();
          this.flagMaybeSet = false;
        }
      } catch (e) {
        if (strict) throw e;
        const t = Date.now();
        if (t - this.lastFlagWarn >= 30_000) {
          this.lastFlagWarn = t;
          this.d.log(`не удалось обновить флаг обслуживания в Redis: ${errorText(e)}`);
        }
      }
    });
    this.flagChain = job.catch(() => {});
    return job;
  }
}
```

- [ ] **Step 5: Запуск — должно пройти**

Run: `source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null && pnpm --filter @carbone-reports/backup-agent test`
Expected: PASS. `lock.test.ts` на macOS — `skipped` (нет `flock`), на Linux (CI) — три теста зелёные. Если «повтор флага не возвращает его после снятия» флакает, причина в коде, а не в таймингах теста: проверить, что `desiredFlag()` вычисляется внутри `flagChain.then`, а не до постановки в очередь.

- [ ] **Step 6: Гейты и коммит**

```bash
cd /Users/sam/carbone-reports
source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null && pnpm exec prettier --write apps/backup-agent && pnpm typecheck && pnpm lint && pnpm exec prettier --check . && pnpm test
git add apps/backup-agent
git commit -m "feat(backup-agent): operation engine with atomic state, op logs, flock, recovery codes and serialized maintenance flag

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Task 3: Реальные шаги, HTTP агента и точка входа (§26.1, §26.2)

**Files:**
- Create: `apps/backup-agent/src/steps.ts`, `src/steps.test.ts`
- Create: `apps/backup-agent/src/server.ts`, `src/server.test.ts`
- Create: `apps/backup-agent/src/main.ts`

**Interfaces:**
- Consumes: Task 1 (`AgentConfig`, `pgConnection`, `parseManifest`, `MANIFEST_FILES`, `assertKnownMigration`, `backupName`, `rotatePreRestore`, `listBackups`, `BACKUP_NAME_RE`, `bundledMigrationHashes`, `createRedactor`, `scheduleCron`, `loadAgentConfig`); Task 2 (`Steps`, `BackupAgent`, `StartResult`, `RecoverResult`, `OperationView`, `Runner`, `run`, `childEnv`, `fileStateStore`, `fileOpLogs`, `flockFile`, `resolveExternally`).
- Produces:
  - `MAINTENANCE_KEY = 'cr:maintenance'`;
  - `interface StepsDeps { cfg: Pick<AgentConfig, 'backupsDir' | 'scriptsDir' | 'migrationsDir' | 'storageBackend' | 'terminateDelayMs'>; env: NodeJS.ProcessEnv; redis: Redis; pool: pg.Pool; redact: Redact; knownMigrations: readonly string[]; run: Runner; now?: () => Date; sleep?: (ms: number) => Promise<void> }`;
  - `createSteps(d): Steps`, `sha256File(path): Promise<string>`, `flushExcept(redis, keep): Promise<number>`;
  - `type AgentApi = Pick<BackupAgent, 'startBackup' | 'startRestore' | 'recover' | 'operation'>`, `buildServer({ agent, token, backupsDir }): FastifyInstance`;
  - HTTP агента:
    - `GET /health` → 200 `{ status: 'ok' }` (без токена);
    - `GET /backups` → 200 `BackupInfo[]`;
    - `POST /backups` (тело `{ requestedBy?: string }`) → 202 `{ operationId }` | 409 `{ error: { code: 'BUSY', message }, busy }`;
    - `POST /backups/:name/restore` (тело `{ requestedBy?: string }`) → 202 | 400 `BAD_NAME` | 404 `NOT_FOUND` | 409 `BUSY`;
    - `GET /operation` → 200 `OperationView` | 204 (операций ещё не было);
    - `POST /recovery { code, target: 'same' | 'pre-restore' }` → 202 | 403 `BAD_CODE` | 409 `NO_RECOVERY` | 409 `BUSY` | 400 `BAD_REQUEST`;
    - без верного `Authorization: Bearer` → 401 `UNAUTHORIZED`;
  - `main.ts`: `node dist/main.js` — агент; `node dist/main.js resolve-external` — отметка для `restore.sh` (нужен только `BACKUPS_DIR`).

Ответ 409 — надмножество тела из спецификации. В нём есть `busy` (§26.1) и стандартный `error` с текстом «уже выполняется другая операция с бэкапами»: API передаёт его как есть, и web показывает этот текст.

- [ ] **Step 1: Падающие тесты**

`apps/backup-agent/src/steps.test.ts`:

```ts
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FUTURE_BACKUP } from './migrations';
import type { Runner } from './run';
import { createSteps, flushExcept, MAINTENANCE_KEY, type StepsDeps } from './steps';

const KNOWN = 'a'.repeat(64);
const NAME = '2026-10-08T03-00-00Z';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'steps-'));
});
afterEach(() => rm(root, { recursive: true, force: true }));

async function backup(name = NAME, opts: { migration?: string; corrupt?: boolean; skip?: string } = {}) {
  const dir = join(root, name);
  await mkdir(dir);
  const files = { 'db.dump': 'dump', 'storage.tar.gz': 'tar' };
  await writeFile(
    join(dir, 'manifest.txt'),
    [
      `created_utc=${name}`,
      `last_migration=${opts.migration ?? KNOWN}`,
      `db.dump size=4 sha256=${sha(files['db.dump'])}`,
      `storage.tar.gz size=3 sha256=${sha(files['storage.tar.gz'])}`,
    ].join('\n'),
  );
  for (const [f, c] of Object.entries(files)) if (f !== opts.skip) await writeFile(join(dir, f), c);
  if (opts.corrupt) await writeFile(join(dir, 'db.dump'), 'испорчен');
  return dir;
}

interface Call {
  cmd: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

function make(over: Partial<StepsDeps> = {}, onRun?: (c: Call) => Promise<void> | void) {
  const calls: Call[] = [];
  const run: Runner = async (cmd, args, o) => {
    const c = { cmd, args, env: o.env };
    calls.push(c);
    await onRun?.(c);
  };
  const steps = createSteps({
    cfg: {
      backupsDir: root,
      scriptsDir: '/backup',
      migrationsDir: '/agent/drizzle',
      storageBackend: 's3',
      terminateDelayMs: 0,
    },
    env: { PGPASSWORD: 'pw', BACKUP_AGENT_TOKEN: 'x'.repeat(32), REDIS_URL: 'redis://:p@r:6379' },
    redis: {} as Redis,
    pool: {} as pg.Pool,
    redact: (s) => s,
    knownMigrations: [KNOWN],
    run,
    now: () => new Date('2026-10-08T10:00:00.123Z'),
    ...over,
  });
  return { steps, calls };
}

const out = () => {};

describe('verify', () => {
  it('s3: контрольные суммы, версия схемы, затем rclone lsf бакета; токен и REDIS_URL скрипту не передаются', async () => {
    await backup();
    const { steps, calls } = make();
    await steps.verify(NAME, out);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe('sh');
    expect(calls[0]!.args[1]).toContain('. "/backup/lib.sh" && check_storage_backend && s3_env && rclone -q lsf --max-depth 1 "s3:$S3_BUCKET"');
    expect(calls[0]!.env).not.toHaveProperty('BACKUP_AGENT_TOKEN');
    expect(calls[0]!.env).not.toHaveProperty('REDIS_URL');
  });

  it('нет файла — отказ до любых команд', async () => {
    await backup(NAME, { skip: 'storage.tar.gz' });
    const { steps, calls } = make();
    await expect(steps.verify(NAME, out)).rejects.toThrow(`в бэкапе ${NAME} нет storage.tar.gz`);
    expect(calls).toEqual([]);
  });

  it('sha256 не совпадает', async () => {
    await backup(NAME, { corrupt: true });
    await expect(make().steps.verify(NAME, out)).rejects.toThrow(
      'контрольная сумма db.dump не совпадает с manifest.txt',
    );
  });

  it('бэкап «из будущего» — отказ, бакет не проверяется', async () => {
    await backup(NAME, { migration: 'f'.repeat(64) });
    const { steps, calls } = make();
    await expect(steps.verify(NAME, out)).rejects.toThrow(FUTURE_BACKUP);
    expect(calls).toEqual([]);
  });

  it('бакет не читается — понятная ошибка', async () => {
    await backup();
    const { steps } = make({}, () => {
      throw new Error('sh: directory not found');
    });
    await expect(steps.verify(NAME, out)).rejects.toThrow('бакет S3 недоступен: sh: directory not found');
  });

  it('local: /data должен быть смонтирован на запись', async () => {
    await backup();
    const { steps, calls } = make(
      { cfg: { backupsDir: root, scriptsDir: '/backup', migrationsDir: '/m', storageBackend: 'local', terminateDelayMs: 0 } },
      () => {
        throw new Error('sh: код 1');
      },
    );
    await expect(steps.verify(NAME, out)).rejects.toThrow('/data не смонтирован на запись');
    expect(calls[0]!.args[1]).toBe('mountpoint -q /data && [ -w /data ]');
  });
});

describe('preBackup, restoreStorage, restoreDb', () => {
  it('preBackup: backup.sh с BACKUP_NAME=pre-restore-<время>; остаются 3 последних pre-restore', async () => {
    for (const d of [1, 2, 3]) await mkdir(join(root, `pre-restore-2026-10-0${d}T00-00-00Z`));
    await mkdir(join(root, NAME));
    const { steps, calls } = make({}, async (c) => {
      await mkdir(join(root, c.env.BACKUP_NAME!));
    });
    expect(await steps.preBackup(out)).toBe('pre-restore-2026-10-08T10-00-00Z');
    expect(calls[0]).toMatchObject({ cmd: '/backup/backup.sh', args: [] });
    expect(calls[0]!.env.BACKUP_NAME).toBe('pre-restore-2026-10-08T10-00-00Z');
    expect((await readdir(root)).sort()).toEqual(
      [NAME, 'pre-restore-2026-10-02T00-00-00Z', 'pre-restore-2026-10-03T00-00-00Z', 'pre-restore-2026-10-08T10-00-00Z'].sort(),
    );
  });

  it('restoreStorage: entrypoint.sh restore-storage с RESTORE_DIR каталога бэкапа', async () => {
    const { steps, calls } = make();
    await steps.restoreStorage(NAME, out);
    expect(calls[0]).toMatchObject({ cmd: '/backup/entrypoint.sh', args: ['restore-storage'] });
    expect(calls[0]!.env.RESTORE_DIR).toBe(join(root, NAME));
  });

  it('restoreDb: pg_restore в SQL-файл, затем одна транзакция psql -1 с удалением схем; временные файлы удаляются', async () => {
    let pre = '';
    const paths: string[] = [];
    const { steps, calls } = make({}, async (c) => {
      if (c.cmd === 'psql') {
        pre = await readFile(c.args[5]!, 'utf8');
        paths.push(c.args[5]!, c.args[7]!);
      }
    });
    await steps.restoreDb(NAME, out);
    expect(calls.map((c) => c.cmd)).toEqual(['pg_restore', 'psql']);
    expect(calls[0]!.args.slice(0, 2)).toEqual(['--no-owner', '-f']);
    expect(calls[0]!.args[3]).toBe(join(root, NAME, 'db.dump'));
    expect(calls[1]!.args.slice(0, 5)).toEqual(['-1', '-v', 'ON_ERROR_STOP=1', '-q', '-f']);
    expect(calls[1]!.args[7]).toBe(calls[0]!.args[2]);
    expect(pre).toBe('DROP SCHEMA IF EXISTS drizzle CASCADE;\nDROP SCHEMA IF EXISTS public CASCADE;\nCREATE SCHEMA public;\n');
    for (const p of paths) expect(existsSync(p)).toBe(false);
  });
});

describe('flushExcept', () => {
  it('SCAN по страницам и UNLINK всего, кроме cr:maintenance', async () => {
    const keys = new Set([MAINTENANCE_KEY, ...Array.from({ length: 1200 }, (_, i) => `cr:k${i}`)]);
    // Снимок берётся один раз: курсор — позиция в нём, удаление ключей страницы не сдвигает.
    const snapshot = [...keys].sort();
    const fake = {
      async scan(cursor: string) {
        const start = Number(cursor);
        const page = snapshot.slice(start, start + 500);
        const next = start + 500 >= snapshot.length ? '0' : String(start + 500);
        return [next, page] as [string, string[]];
      },
      async unlink(...victims: string[]) {
        for (const v of victims) keys.delete(v);
        return victims.length;
      },
    };
    expect(await flushExcept(fake as unknown as Redis, MAINTENANCE_KEY)).toBe(1200);
    expect([...keys]).toEqual([MAINTENANCE_KEY]);
  });
});
```

`apps/backup-agent/src/server.test.ts`:

```ts
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OperationView } from './agent';
import { buildServer, type AgentApi } from './server';

const TOKEN = 'k'.repeat(40);
const auth = { authorization: `Bearer ${TOKEN}` };
const NAME = '2026-10-08T03-00-00Z';

let root: string;
let agent: { [K in keyof AgentApi]: ReturnType<typeof vi.fn> };
let app: ReturnType<typeof buildServer>;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'srv-'));
  await mkdir(join(root, NAME));
  agent = {
    startBackup: vi.fn(async () => ({ operationId: 'op1' })),
    startRestore: vi.fn(async () => ({ operationId: 'op2' })),
    recover: vi.fn(async () => ({ operationId: 'op3' })),
    operation: vi.fn(async () => null),
  };
  app = buildServer({ agent: agent as unknown as AgentApi, token: TOKEN, backupsDir: root });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});

describe('авторизация', () => {
  it('/health без токена — 200', async () => {
    const r = await app.inject({ method: 'GET', url: '/health' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ status: 'ok' });
  });
  it.each([
    ['без заголовка', {}],
    ['неверный токен', { authorization: `Bearer ${'x'.repeat(40)}` }],
    ['токен другой длины', { authorization: 'Bearer short' }],
    ['другая схема', { authorization: `Basic ${TOKEN}` }],
  ])('%s — 401', async (_n, headers) => {
    const r = await app.inject({ method: 'GET', url: '/backups', headers });
    expect(r.statusCode).toBe(401);
    expect(r.json()).toEqual({ error: { code: 'UNAUTHORIZED', message: 'требуется токен агента' } });
    expect(r.body).not.toContain(TOKEN);
  });
});

describe('маршруты', () => {
  it('GET /backups — список каталога', async () => {
    const r = await app.inject({ method: 'GET', url: '/backups', headers: auth });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual([expect.objectContaining({ name: NAME, status: 'partial', kind: 'regular' })]);
  });

  it('POST /backups — 202 и requestedBy; без тела — api', async () => {
    let r = await app.inject({ method: 'POST', url: '/backups', headers: auth, payload: { requestedBy: 'admin' } });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toEqual({ operationId: 'op1' });
    expect(agent.startBackup).toHaveBeenCalledWith('admin');
    r = await app.inject({ method: 'POST', url: '/backups', headers: auth });
    expect(r.statusCode).toBe(202);
    expect(agent.startBackup).toHaveBeenLastCalledWith('api');
  });

  it('занято — 409 с busy и текстом ошибки', async () => {
    agent.startBackup.mockResolvedValueOnce({ busy: { type: 'restore', startedAt: '2026-10-08T10:00:00.000Z' } });
    const r = await app.inject({ method: 'POST', url: '/backups', headers: auth, payload: {} });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({
      error: { code: 'BUSY', message: 'уже выполняется другая операция с бэкапами' },
      busy: { type: 'restore', startedAt: '2026-10-08T10:00:00.000Z' },
    });
  });

  it('restore: неверное имя — 400, нет каталога — 404, .partial — 400; агент не вызывается', async () => {
    for (const [name, code] of [
      ['..%2Fetc', 400],
      [`${NAME}.partial`, 400],
      ['2026-10-09T03-00-00Z', 404],
    ] as const) {
      const r = await app.inject({ method: 'POST', url: `/backups/${name}/restore`, headers: auth, payload: {} });
      expect(r.statusCode).toBe(code);
    }
    expect(agent.startRestore).not.toHaveBeenCalled();
  });

  it('restore: 202, имя и логин передаются агенту', async () => {
    const r = await app.inject({ method: 'POST', url: `/backups/${NAME}/restore`, headers: auth, payload: { requestedBy: 'admin' } });
    expect(r.statusCode).toBe(202);
    expect(agent.startRestore).toHaveBeenCalledWith(NAME, 'admin');
  });

  it('GET /operation: 204 без операций, 200 с операцией', async () => {
    expect((await app.inject({ method: 'GET', url: '/operation', headers: auth })).statusCode).toBe(204);
    const view = { id: 'op1', status: 'running', log: ['этап: db'], recovery: null } as unknown as OperationView;
    agent.operation.mockResolvedValueOnce(view);
    const r = await app.inject({ method: 'GET', url: '/operation', headers: auth });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual(view);
  });

  it('POST /recovery: 202, 403 неверный код, 403 со сгоревшим кодом, 409 без состояния, 400 без цели', async () => {
    const call = (payload: unknown) => app.inject({ method: 'POST', url: '/recovery', headers: auth, payload: payload as object });
    let r = await call({ code: 'ABCD-EFGH-IJKL', target: 'same' });
    expect(r.statusCode).toBe(202);
    expect(agent.recover).toHaveBeenCalledWith('ABCD-EFGH-IJKL', 'same');

    agent.recover.mockResolvedValueOnce({ error: 'bad-code', burned: false });
    r = await call({ code: 'X', target: 'pre-restore' });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toEqual({ code: 'BAD_CODE', message: 'неверный код восстановления' });

    agent.recover.mockResolvedValueOnce({ error: 'bad-code', burned: true });
    r = await call({ code: 'X', target: 'same' });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.message).toContain('новый код в журнале сервиса backup');

    agent.recover.mockResolvedValueOnce({ error: 'no-recovery' });
    r = await call({ code: 'X', target: 'same' });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('NO_RECOVERY');

    r = await call({ code: 'X' });
    expect(r.statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Запуск — должно упасть**

Run: `source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null && pnpm --filter @carbone-reports/backup-agent test`
Expected: FAIL — `Failed to resolve import "./steps"` и `"./server"`.

- [ ] **Step 3: `steps.ts`**

`apps/backup-agent/src/steps.ts`:

```ts
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { Redis } from 'ioredis';
import type pg from 'pg';
import type { Steps } from './agent';
import { backupName, rotatePreRestore } from './backups';
import type { AgentConfig } from './config';
import { MANIFEST_FILES, parseManifest } from './manifest';
import { assertKnownMigration } from './migrations';
import type { Redact } from './redact';
import { childEnv, type Out, type Runner } from './run';

/** Флаг обслуживания (§26.2): его читает middleware API. */
export const MAINTENANCE_KEY = 'cr:maintenance';

export interface StepsDeps {
  cfg: Pick<AgentConfig, 'backupsDir' | 'scriptsDir' | 'migrationsDir' | 'storageBackend' | 'terminateDelayMs'>;
  env: NodeJS.ProcessEnv;
  redis: Redis;
  pool: pg.Pool;
  redact: Redact;
  knownMigrations: readonly string[];
  run: Runner;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
}

export async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest('hex');
}

/** Удаляет все ключи Redis, кроме keep: SCAN по страницам и UNLINK (§26.2, фаза redis). */
export async function flushExcept(redis: Redis, keep: string): Promise<number> {
  let cursor = '0';
  let removed = 0;
  do {
    const [next, keys] = await redis.scan(cursor, 'COUNT', 500);
    cursor = next;
    const victims = keys.filter((k) => k !== keep);
    if (victims.length > 0) removed += await redis.unlink(...victims);
  } while (cursor !== '0');
  return removed;
}

const PRE_SQL =
  'DROP SCHEMA IF EXISTS drizzle CASCADE;\nDROP SCHEMA IF EXISTS public CASCADE;\nCREATE SCHEMA public;\n';

export function createSteps(d: StepsDeps): Steps {
  const { cfg } = d;
  const now = d.now ?? (() => new Date());
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const dirOf = (name: string) => join(cfg.backupsDir, name);
  const script = (name: string) => join(cfg.scriptsDir, name);
  const exec = (cmd: string, args: string[], out: Out, extra: Record<string, string> = {}) =>
    d.run(cmd, args, { env: childEnv(d.env, extra), out, redact: d.redact });

  return {
    async backup(out) {
      await exec(script('backup.sh'), [], out);
    },

    async verify(name, out) {
      const dir = dirOf(name);
      for (const f of [...MANIFEST_FILES, 'manifest.txt']) {
        try {
          await access(join(dir, f));
        } catch {
          throw new Error(`в бэкапе ${name} нет ${f}`);
        }
      }
      const manifest = parseManifest(await readFile(join(dir, 'manifest.txt'), 'utf8'));
      for (const f of MANIFEST_FILES)
        if ((await sha256File(join(dir, f))) !== manifest.files[f].sha256)
          throw new Error(`контрольная сумма ${f} не совпадает с manifest.txt`);
      out('контрольные суммы совпадают с manifest.txt');
      assertKnownMigration(manifest.lastMigration, d.knownMigrations);
      out('версия схемы бэкапа известна этой версии приложения');
      if (cfg.storageBackend === 's3') {
        await exec(
          'sh',
          ['-c', `. "${script('lib.sh')}" && check_storage_backend && s3_env && rclone -q lsf --max-depth 1 "s3:$S3_BUCKET" >/dev/null`],
          out,
        ).catch((e: Error) => {
          throw new Error(`бакет S3 недоступен: ${e.message}`);
        });
        out('бакет S3 читается');
      } else {
        await exec('sh', ['-c', 'mountpoint -q /data && [ -w /data ]'], out).catch(() => {
          throw new Error(
            '/data не смонтирован на запись: при STORAGE_BACKEND=local смонтируйте том хранилища в сервис backup',
          );
        });
      }
    },

    async preBackup(out) {
      const name = backupName(now(), 'pre-restore-');
      await exec(script('backup.sh'), [], out, { BACKUP_NAME: name });
      for (const old of await rotatePreRestore(cfg.backupsDir)) out(`удалён старый бэкап ${old}`);
      return name;
    },

    async terminateApi(out) {
      // Пауза: за 3 с все экземпляры API увидят флаг (кэш 1 с) и перестанут брать соединения.
      await sleep(cfg.terminateDelayMs);
      const r = await d.pool.query<{ n: string }>(
        `select count(pg_terminate_backend(pid))::text as n from pg_stat_activity
         where application_name = 'api' and datname = current_database() and pid <> pg_backend_pid()`,
      );
      out(`завершено сессий API: ${r.rows[0]?.n ?? '0'}`);
    },

    async restoreDb(name, out) {
      // Как scripts/restore.sh: SQL сначала пишется в файл (обрыв pg_restore не даст обрезанный скрипт),
      // затем схемы drizzle и public удаляются и создаются из дампа в ОДНОЙ транзакции (psql -1).
      const tmp = await mkdtemp(join(tmpdir(), 'cr-restore-'));
      try {
        const sql = join(tmp, 'restore.sql');
        const pre = join(tmp, 'restore-pre.sql');
        await exec('pg_restore', ['--no-owner', '-f', sql, join(dirOf(name), 'db.dump')], out);
        await writeFile(pre, PRE_SQL);
        await exec('psql', ['-1', '-v', 'ON_ERROR_STOP=1', '-q', '-f', pre, '-f', sql], out);
        out('база заменена данными из бэкапа');
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    },

    async migrate(out) {
      await migrate(drizzle(d.pool), { migrationsFolder: cfg.migrationsDir });
      out('миграции применены');
    },

    async restoreStorage(name, out) {
      await exec(script('entrypoint.sh'), ['restore-storage'], out, { RESTORE_DIR: dirOf(name) });
    },

    async flushRedis(out) {
      out(`удалено ключей Redis: ${await flushExcept(d.redis, MAINTENANCE_KEY)}`);
    },

    async setFlag(flag) {
      await d.redis.set(MAINTENANCE_KEY, JSON.stringify(flag));
    },

    async clearFlag() {
      await d.redis.del(MAINTENANCE_KEY);
    },
  };
}
```

- [ ] **Step 4: `server.ts`**

`apps/backup-agent/src/server.ts`:

```ts
import { createHash, timingSafeEqual } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import Fastify, { type FastifyReply } from 'fastify';
import { z } from 'zod';
import type { BackupAgent, StartResult } from './agent';
import { BACKUP_NAME_RE, listBackups } from './backups';

export type AgentApi = Pick<BackupAgent, 'startBackup' | 'startRestore' | 'recover' | 'operation'>;

const err = (code: string, message: string) => ({ error: { code, message } });
const digest = (s: string) => createHash('sha256').update(s).digest();

const RequestedBy = z.object({ requestedBy: z.string().trim().min(1).max(256).default('api') });
const RecoveryBody = z.object({
  code: z.string().trim().min(1).max(64),
  target: z.enum(['same', 'pre-restore']),
});

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export function buildServer(o: { agent: AgentApi; token: string; backupsDir: string }) {
  const app = Fastify({ logger: false, bodyLimit: 16 * 1024 });
  const want = digest(o.token);

  // Сравнение за постоянное время: сравниваются sha256 (одинаковой длины) — ни длина, ни
  // совпавший префикс токена не влияют на время ответа.
  app.addHook('onRequest', async (req, reply) => {
    if (req.method === 'GET' && req.url === '/health') return;
    const header = req.headers.authorization ?? '';
    const got = digest(header.startsWith('Bearer ') ? header.slice(7) : '');
    if (!timingSafeEqual(got, want)) {
      reply.code(401).send(err('UNAUTHORIZED', 'требуется токен агента'));
      return reply;
    }
  });

  const started = (reply: FastifyReply, r: StartResult) =>
    'busy' in r
      ? reply.code(409).send({ ...err('BUSY', 'уже выполняется другая операция с бэкапами'), busy: r.busy })
      : reply.code(202).send(r);

  const badRequest = (reply: FastifyReply) => reply.code(400).send(err('BAD_REQUEST', 'неверные данные запроса'));

  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/backups', async () => listBackups(o.backupsDir));

  app.post('/backups', async (req, reply) => {
    const b = RequestedBy.safeParse(req.body ?? {});
    if (!b.success) return badRequest(reply);
    return started(reply, await o.agent.startBackup(b.data.requestedBy));
  });

  app.post<{ Params: { name: string } }>('/backups/:name/restore', async (req, reply) => {
    const { name } = req.params;
    if (!BACKUP_NAME_RE.test(name)) return reply.code(400).send(err('BAD_NAME', 'неверное имя бэкапа'));
    if (!(await isDir(join(o.backupsDir, name))))
      return reply.code(404).send(err('NOT_FOUND', 'бэкап не найден'));
    const b = RequestedBy.safeParse(req.body ?? {});
    if (!b.success) return badRequest(reply);
    return started(reply, await o.agent.startRestore(name, b.data.requestedBy));
  });

  app.get('/operation', async (_req, reply) => {
    const op = await o.agent.operation();
    return op ? op : reply.code(204).send();
  });

  app.post('/recovery', async (req, reply) => {
    const b = RecoveryBody.safeParse(req.body ?? {});
    if (!b.success) return badRequest(reply);
    const r = await o.agent.recover(b.data.code, b.data.target);
    if ('error' in r) {
      if (r.error === 'no-recovery')
        return reply.code(409).send(err('NO_RECOVERY', 'восстановление по коду не требуется'));
      return reply
        .code(403)
        .send(
          err(
            'BAD_CODE',
            r.burned
              ? 'неверный код восстановления; после 5 неверных попыток код заменён — новый код в журнале сервиса backup (docker compose logs backup)'
              : 'неверный код восстановления',
          ),
        );
    }
    return started(reply, r);
  });

  return app;
}
```

- [ ] **Step 5: `main.ts`**

`apps/backup-agent/src/main.ts`:

```ts
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Redis } from 'ioredis';
import pg from 'pg';
import { BackupAgent } from './agent';
import { loadAgentConfig, pgConnection, type AgentConfig } from './config';
import { scheduleCron } from './cron';
import { flockFile } from './lock';
import { bundledMigrationHashes } from './migrations';
import { fileOpLogs } from './oplog';
import { createRedactor } from './redact';
import { run } from './run';
import { buildServer } from './server';
import { fileStateStore, resolveExternally } from './state';
import { createSteps } from './steps';

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

// scripts/restore.sh: `docker compose run --rm --no-deps --entrypoint node backup /agent/dist/main.js resolve-external`.
if (process.argv[2] === 'resolve-external') {
  const store = fileStateStore(join(process.env.BACKUPS_DIR || '/backups', '.op'));
  log(
    (await resolveExternally(store))
      ? 'незавершённое восстановление из админки отмечено: failed (resolved externally)'
      : 'незавершённых восстановлений из админки нет',
  );
  process.exit(0);
}

let cfg: AgentConfig;
try {
  cfg = loadAgentConfig(process.env);
} catch (e) {
  console.error((e as Error).message);
  process.exit(2);
}

const redact = createRedactor(process.env);
const redis = new Redis(cfg.redisUrl, { maxRetriesPerRequest: 2, connectTimeout: 2000, commandTimeout: 2000 });
let lastRedisWarn = 0;
redis.on('error', (e: Error) => {
  if (Date.now() - lastRedisWarn > 30_000) {
    lastRedisWarn = Date.now();
    log(`Redis: ${redact(e.message)}`);
  }
});
const pool = new pg.Pool({ ...pgConnection(process.env), max: 2, application_name: 'backup-agent' });
pool.on('error', (e) => log(`postgres: ${redact(e.message)}`));

const known = bundledMigrationHashes(cfg.migrationsDir);
const opDir = join(cfg.backupsDir, '.op');
await mkdir(opDir, { recursive: true });

const agent = new BackupAgent({
  steps: createSteps({ cfg, env: process.env, redis, pool, redact, knownMigrations: known, run }),
  store: fileStateStore(opDir),
  lock: flockFile(join(cfg.backupsDir, '.op.lock')),
  logs: fileOpLogs(opDir),
  // Код восстановления — только сюда (docker compose logs backup), не в журнал операции (§26.4).
  printCode: (code) => console.log(`КОД ВОССТАНОВЛЕНИЯ: ${code}`),
  log,
  reassertMs: cfg.reassertMs,
});
await agent.init();

const stopCron = scheduleCron(cfg.cron, cfg.tz, () => {
  agent.startBackup('cron').then(
    (r) => {
      if ('busy' in r) log('бэкап по расписанию пропущен: идёт другая операция с бэкапами');
    },
    (e: Error) => log(`бэкап по расписанию не запущен: ${redact(e.message)}`),
  );
});

const app = buildServer({ agent, token: cfg.token, backupsDir: cfg.backupsDir });
await app.listen({ host: '0.0.0.0', port: cfg.port });
log(
  `агент бэкапа: порт ${cfg.port}, расписание «${cfg.cron}» (TZ=${cfg.tz}), хранилище ${cfg.storageBackend}, миграций в образе: ${known.length}`,
);

async function shutdown(signal: string) {
  log(`${signal}: остановка агента`);
  stopCron();
  agent.close();
  await app.close();
  await pool.end().catch(() => {});
  redis.disconnect();
  process.exit(0);
}
// node — PID 1 в контейнере: без обработчиков docker stop ждал бы KILL.
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
```

- [ ] **Step 6: Запуск — должно пройти**

Run: `source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null && pnpm --filter @carbone-reports/backup-agent test && pnpm --filter @carbone-reports/backup-agent typecheck`
Expected: PASS; `typecheck` без ошибок (в том числе `main.ts`).

- [ ] **Step 7: Гейты и коммит**

```bash
cd /Users/sam/carbone-reports
source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null && pnpm exec prettier --write apps/backup-agent && pnpm typecheck && pnpm lint && pnpm exec prettier --check . && pnpm test
git add apps/backup-agent
git commit -m "feat(backup-agent): real steps (scripts, pg_restore, drizzle migrate, redis), bearer-protected HTTP API and entry point

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Task 4: Образ `backup` с агентом, скрипты, compose, `restore.sh` и интеграционные тесты агента (§26.1, §26.2, §26.4, §26.6, §26.7)

**Files:**
- Modify: `docker/backup/Dockerfile` (целиком)
- Modify: `docker/backup/entrypoint.sh` (целиком)
- Modify: `docker/backup/backup.sh:20` (строка `name=…`)
- Modify: `.dockerignore` (в конец)
- Modify: `docker-compose.yml` (сервисы `api`, `redis`, `backup`, блок `networks`)
- Modify: `.env.example`
- Modify: `scripts/restore.sh`
- Modify: `.github/workflows/ci.yml` (задача `integration`)
- Modify: `apps/backup-agent/package.json` (скрипт `test:int`)
- Create: `apps/backup-agent/vitest.int.config.ts`, `apps/backup-agent/test/global-setup.ts`, `apps/backup-agent/test/helpers.ts`, `apps/backup-agent/test/agent.int.test.ts`
- Create: `apps/backup-agent/src/compose.test.ts`

**Interfaces:**
- Consumes: Task 1–3 целиком (`dist/main.js`, `resolve-external`, HTTP агента); `docker/backup/lib.sh` (`check_backup_timeout`, `check_storage_backend`, `s3_env`) без изменений; `docker/s3/entrypoint.sh` и образ `chrislusf/seaweedfs:4.48` (как в `apps/api/test/global-setup.ts`).
- Produces:
  - образ `carbone-reports-backup`: `ENTRYPOINT ["/backup/entrypoint.sh"]`, `CMD ["agent"]`; агент `/agent/dist/main.js`, миграции `/agent/drizzle`, скрипты `/backup/*.sh`;
  - `entrypoint.sh` — режимы `agent | now | restore-storage`; `now` при занятом замке → код 75 «идёт другая операция с бэкапами (агент) — повторите позже»; `restore-storage` читает `${RESTORE_DIR:-/restore}`;
  - `backup.sh` — необязательный `BACKUP_NAME` (`<время>` или `pre-restore-<время>`, иначе код 2);
  - compose: `backup` в стеке (`http://backup:8080` в сети `backup`), `api` с `BACKUP_AGENT_URL=http://backup:8080` и `BACKUP_AGENT_TOKEN`;
  - `.env.example`: `BACKUP_AGENT_TOKEN=` (обязателен для compose);
  - тестовые помощники агента: `startAgent`, `createAppDatabase`, `migrateTo`, `hostPool`, `hostRedis`, `rclone`, `pgUrl`.

Почему агент проверяется в контейнере: шаги вызывают `pg_dump` 17, `pg_restore`, `psql`, `rclone`, `flock`, `mountpoint` и пути `/backup`, `/backups`. Проверка того же образа, что уходит в compose и GHCR, заодно проверяет `Dockerfile` и `entrypoint.sh`. Все тесты — в одном файле и последовательно (`fileParallelism: false`): Redis и флаг `cr:maintenance` общие.

- [ ] **Step 1: Место на диске и образ**

```bash
df -h /System/Volumes/Data | tail -1     # свободно ≥ 3 GiB, иначе BLOCKED
docker image ls node:22-bookworm-slim --format '{{.Repository}}:{{.Tag}}'   # есть (база api)
docker image ls postgres:17-alpine --format '{{.Repository}}:{{.Tag}}'      # есть
```

`docker/backup/Dockerfile` — целиком:

```dockerfile
# Образ сервиса backup: агент бэкапа (apps/backup-agent, Node) и скрипты docker/backup поверх
# postgres:17-alpine (pg_dump той же мажорной версии, что у сервера) с rclone (STORAGE_BACKEND=s3).
# Контекст сборки — корень репозитория: в образ входят агент и миграции apps/api/drizzle того же
# коммита — по ним агент проверяет версию схемы бэкапа и доводит восстановленную базу до текущей.
# Без BuildKit-only инструкций: образ собирается и классическим сборщиком (testcontainers).

# --- Сборка агента (тот же базовый образ, что у api) ---
FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true
RUN corepack enable && corepack prepare pnpm@10.34.6 --activate
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY apps/backup-agent/package.json apps/backup-agent/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter @carbone-reports/backup-agent...
COPY apps/backup-agent apps/backup-agent
RUN pnpm --filter @carbone-reports/backup-agent build
# Зависимости агента — чистый JS: node_modules этого этапа (glibc) работают и на alpine (musl).
RUN pnpm --filter @carbone-reports/backup-agent deploy --prod --legacy /out \
 && cp -r apps/backup-agent/dist /out/ \
 && rm -rf /out/src /out/test

# --- Образ ---
FROM postgres:17-alpine
RUN apk add --no-cache rclone nodejs
COPY docker/backup/entrypoint.sh docker/backup/backup.sh docker/backup/archive-storage.sh docker/backup/lib.sh /backup/
RUN chmod 755 /backup/*.sh
COPY --from=build /out /agent
COPY apps/api/drizzle /agent/drizzle
ENTRYPOINT ["/backup/entrypoint.sh"]
CMD ["agent"]
```

`.dockerignore` — в конец (каталог бэкапов и отчёты E2E не должны уходить в контекст сборки ни одного образа):

```
backups
e2e/report
e2e/test-results
```

- [ ] **Step 2: Скрипты**

`docker/backup/backup.sh` — строку `name=$(date -u +%Y-%m-%dT%H-%M-%SZ)` заменить на:

```sh
# BACKUP_NAME задаёт агент для бэкапа перед восстановлением (pre-restore-<время>). Ротация
# BACKUP_KEEP ниже такие каталоги не трогает: pre-restore-* ротирует агент (последние 3).
name=${BACKUP_NAME:-$(date -u +%Y-%m-%dT%H-%M-%SZ)}
case $name in
  [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]-[0-9][0-9]-[0-9][0-9]Z) ;;
  pre-restore-[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]-[0-9][0-9]-[0-9][0-9]Z) ;;
  *) echo "BACKUP_NAME: ожидается ГГГГ-ММ-ДДTЧЧ-ММ-ССZ или pre-restore-ГГГГ-ММ-ДДTЧЧ-ММ-ССZ" >&2; exit 2 ;;
esac
```

`docker/backup/entrypoint.sh` — целиком:

```sh
#!/bin/sh
set -eu
# shellcheck source-path=SCRIPTDIR
. "$(dirname "$0")/lib.sh"
case "${1:-agent}" in
  agent)
    # Агент бэкапа (apps/backup-agent): расписание BACKUP_CRON в часовом поясе TZ, бэкапы и
    # восстановление из админки. BACKUP_CRON и токен проверяет агент (код 2), здесь — то же,
    # что проверяет backup.sh: неверное значение видно сразу при старте, а не в 3 часа ночи.
    check_backup_timeout
    check_storage_backend
    exec node /agent/dist/main.js ;;
  now)
    # Ручной бэкап: docker compose run --rm backup now. Одна операция за раз — тот же замок
    # /backups/.op.lock, что у агента. fd 9 наследует backup.sh, замок держится до его конца.
    mkdir -p /backups
    exec 9>>/backups/.op.lock
    flock -n 9 || { echo "идёт другая операция с бэкапами (агент) — повторите позже" >&2; exit 75; }
    exec "$(dirname "$0")/backup.sh" ;;
  restore-storage)
    # Агент: RESTORE_DIR=/backups/<имя>; scripts/restore.sh: каталог бэкапа смонтирован в /restore.
    # local: распаковка в /data (том смонтирован на запись); s3: распаковка во временный каталог
    # и rclone sync в бакет — объекты, которых нет в архиве, удаляются.
    check_storage_backend
    src=${RESTORE_DIR:-/restore}
    a=$src/storage.tar.gz
    [ -f "$a" ] || { echo "нет $a" >&2; exit 1; }
    # Все проверки — до изменений: при любой ошибке хранилище остаётся нетронутым.
    if [ "$STORAGE_BACKEND" = local ]; then
      mountpoint -q /data || { echo "/data не смонтирован" >&2; exit 1; }
    fi
    if ! { gzip -t "$a" && tar -tzf "$a" >/dev/null; }; then echo "архив повреждён" >&2; exit 1; fi
    if [ -f "$src/manifest.txt" ]; then
      want=$(sed -n 's/^storage\.tar\.gz .*sha256=\([0-9a-f]*\).*$/\1/p' "$src/manifest.txt")
      got=$(sha256sum "$a" | cut -d' ' -f1)
      [ -n "$want" ] && [ "$want" = "$got" ] || { echo "sha256 архива не совпадает с manifest.txt" >&2; exit 1; }
    fi
    if [ "$STORAGE_BACKEND" = local ]; then
      find /data -mindepth 1 -delete
      tar -xzf "$a" -C /data
    else
      s3_env
      tmp=$(mktemp -d)
      trap 'rm -rf "$tmp"' EXIT
      tar -xzf "$a" -C "$tmp"
      rclone sync --checksum "$tmp" "s3:$S3_BUCKET"
    fi
    echo "хранилище восстановлено ($STORAGE_BACKEND)" ;;
  *) echo "режимы: agent | now | restore-storage" >&2; exit 2 ;;
esac
```

```bash
cd /Users/sam/carbone-reports
sh -n docker/backup/entrypoint.sh && sh -n docker/backup/backup.sh && echo синтаксис-ок
command -v shellcheck >/dev/null && shellcheck docker/backup/*.sh scripts/restore.sh || echo "shellcheck не установлен — пропуск"
```

- [ ] **Step 3: Compose и `.env.example`**

`docker-compose.yml`, сервис `api` — в `environment` после `REDIS_URL` добавить:

```yaml
      # Агент бэкапа (сервис backup) во внутренней сети backup: бэкапы и восстановление из админки.
      BACKUP_AGENT_URL: http://backup:8080
      BACKUP_AGENT_TOKEN: ${BACKUP_AGENT_TOKEN:?задайте BACKUP_AGENT_TOKEN в .env}
```

и строку `    networks: [default, cache, s3]` у `api` заменить на:

```yaml
    networks: [default, cache, s3, backup]
```

Сервис `redis`: комментарий `# Только внутренняя сеть cache: Redis доступен одному api.` заменить на `# Только внутренняя сеть cache: Redis доступен api и агенту бэкапа (флаг обслуживания).`

Сервис `backup` — целиком:

```yaml
  backup:
    image: ${BACKUP_IMAGE:-carbone-reports-backup}
    # Агент бэкапа (apps/backup-agent): расписание BACKUP_CRON, бэкапы и восстановление из админки.
    # postgres:17-alpine + rclone + Node; скрипты docker/backup и миграции apps/api/drizzle — в образе,
    # поэтому контекст сборки — корень репозитория.
    build:
      context: .
      dockerfile: docker/backup/Dockerfile
    command: ['agent']
    environment:
      <<: *s3-env
      PGPASSWORD: ${POSTGRES_PASSWORD:?задайте POSTGRES_PASSWORD в .env}
      REDIS_URL: redis://:${REDIS_PASSWORD:?задайте REDIS_PASSWORD в .env}@redis:6379
      BACKUP_AGENT_TOKEN: ${BACKUP_AGENT_TOKEN:?задайте BACKUP_AGENT_TOKEN в .env}
      BACKUP_CRON: ${BACKUP_CRON:-0 3 * * *}
      BACKUP_KEEP: ${BACKUP_KEEP:-14}
      BACKUP_TIMEOUT: ${BACKUP_TIMEOUT:-3600}
      TZ: ${TZ:-Europe/Moscow}
    volumes:
      - ${BACKUP_DIR:-./backups}:/backups
    # default — postgres; s3 — бакет; cache — Redis (флаг обслуживания); backup — HTTP агента для api.
    # Порт 8080 наружу не публикуется.
    networks: [default, s3, cache, backup]
    healthcheck:
      test: ['CMD', 'wget', '-q', '-O', '/dev/null', 'http://127.0.0.1:8080/health']
      interval: 10s
      timeout: 3s
      retries: 6
      start_period: 15s
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
      s3:
        condition: service_healthy
    logging: *logging
    restart: unless-stopped
```

Блок `networks` — целиком:

```yaml
networks:
  # Внутренние сети без выхода наружу: cache — api, redis и backup; s3 — api, backup и s3;
  # backup — api и агент бэкапа.
  cache:
    internal: true
  s3:
    internal: true
  backup:
    internal: true
```

`.env.example`:
- после строки `S3_SECRET_ACCESS_KEY=` добавить:

  ```
  # Токен агента бэкапа (сервис backup; управление бэкапами в админке), не короче 32 символов: openssl rand -hex 32
  BACKUP_AGENT_TOKEN=
  ```

- строку `# Бэкап (docker compose --profile backup up -d backup): расписание cron, сколько копий хранить, каталог на хосте` заменить на:

  ```
  # Бэкап (сервис backup запускается вместе со стеком; бэкапы и восстановление — в админке, «Бэкапы»):
  # расписание cron в часовом поясе TZ, сколько обычных копий хранить (pre-restore-* — всегда 3), каталог на хосте
  ```

- после строки `# REDIS_URL=redis://:<пароль>@localhost:6379` добавить:

  ```
  # Управление бэкапами из админки: адрес агента и тот же BACKUP_AGENT_TOKEN. Без адреса функция выключена.
  # В Docker задаёт docker-compose.yml (http://backup:8080); порт агента наружу не публикуется.
  # BACKUP_AGENT_URL=
  ```

`apps/backup-agent/src/compose.test.ts` (юнит-тест, читает файл):

```ts
import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

interface Service {
  profiles?: string[];
  ports?: unknown;
  entrypoint?: unknown;
  command?: string[];
  build?: unknown;
  networks?: string[];
  volumes?: string[];
  environment: Record<string, string>;
}
const compose = parse(await readFile(new URL('../../../docker-compose.yml', import.meta.url), 'utf8'), {
  merge: true,
}) as { services: Record<string, Service>; networks: Record<string, unknown> };

describe('docker-compose.yml: агент бэкапа', () => {
  it('backup запускается со стеком: без профиля и портов, агент из образа, токен обязателен', () => {
    const b = compose.services.backup!;
    expect(b.profiles).toBeUndefined();
    expect(b.ports).toBeUndefined();
    expect(b.entrypoint).toBeUndefined();
    expect(b.command).toEqual(['agent']);
    expect(b.build).toEqual({ context: '.', dockerfile: 'docker/backup/Dockerfile' });
    expect(b.networks).toEqual(['default', 's3', 'cache', 'backup']);
    expect(b.volumes).toEqual(['${BACKUP_DIR:-./backups}:/backups']);
    expect(b.environment.BACKUP_AGENT_TOKEN).toMatch(/^\$\{BACKUP_AGENT_TOKEN:\?/);
    expect(b.environment.REDIS_URL).toMatch(/^redis:\/\/:\$\{REDIS_PASSWORD:\?[^}]*\}@redis:6379$/);
    expect(compose.networks.backup).toEqual({ internal: true });
  });

  it('api знает адрес и токен агента и подключён к сети backup', () => {
    const a = compose.services.api!;
    expect(a.environment.BACKUP_AGENT_URL).toBe('http://backup:8080');
    expect(a.environment.BACKUP_AGENT_TOKEN).toMatch(/^\$\{BACKUP_AGENT_TOKEN:\?/);
    expect(a.networks).toContain('backup');
  });

  it('redis — только во внутренней сети cache', () => {
    expect(compose.services.redis!.networks).toEqual(['cache']);
  });
});
```

`compose.test.ts` использует top-level `await`: модуль ESM (`"type": "module"`), `target` ES2023 — vitest это поддерживает.

- [ ] **Step 4: `scripts/restore.sh`**

Правки по местам (остальное без изменений):

1. Комментарий в строке 2 заменить на:

   ```sh
   # Восстановление из каталога бэкапа: БД app и файлы хранилища. Останавливает api, web и агент бэкапа
   # (сервис backup), очищает Redis. Аварийный путь: обычно восстановление запускается из админки («Бэкапы»).
   ```

2. Блок от `# Бэкап по расписанию на время восстановления приостанавливается:` до `bk=$(docker compose --profile backup ps -q --status running backup)` заменить на:

   ```sh
   # Агент бэкапа (сервис backup: расписание и операции из админки) на время восстановления
   # останавливается: он не снимет копию посреди замены файлов и не вернёт флаг обслуживания.
   bk=$(docker compose ps -q --status running backup)
   ```

3. Строку `[ -z "$bk" ] || echo "Бэкап по расписанию (сервис backup) будет приостановлен на время восстановления."` заменить на:

   ```sh
   [ -z "$bk" ] || echo "Агент бэкапа (сервис backup) будет остановлен на время восстановления."
   echo "Незавершённое восстановление из админки (если есть) будет отмечено как выполненное этим скриптом."
   ```

4. В `on_exit`: `docker compose --profile backup start backup >&2 || echo "не удалось запустить сервис backup" >&2` → `docker compose start backup >&2 || echo "не удалось запустить сервис backup" >&2`.
5. `  docker compose --profile backup stop backup` → `  docker compose stop backup`.
6. `  docker compose --profile backup run --rm -T --no-deps --entrypoint sh backup -c \` → `  docker compose run --rm -T --no-deps --entrypoint sh backup -c \`.
7. `  docker compose --profile backup run --rm -T --no-deps -v "$dir":/restore:ro backup restore-storage` → `  docker compose run --rm -T --no-deps -v "$dir":/restore:ro backup restore-storage`.
8. Сразу после строки `phase=storage` (перед комментарием про Redis) вставить:

   ```sh
   # §26.4: восстановление из админки, прерванное сбоем, закрыто этим скриптом — агент после запуска
   # не вернёт флаг обслуживания. Сам флаг в Redis снимает FLUSHALL ниже.
   docker compose run --rm -T --no-deps --entrypoint node backup /agent/dist/main.js resolve-external || {
     echo "не удалось отметить восстановление из админки в state.json: агент может снова включить обслуживание" >&2
     exit 1
   }
   ```

9. В конце блок

   ```sh
     docker compose --profile backup start backup ||
       echo "не удалось запустить сервис backup: docker compose --profile backup up -d backup" >&2
   ```

   заменить на:

   ```sh
     docker compose start backup ||
       echo "не удалось запустить сервис backup: docker compose up -d backup" >&2
   ```

```bash
cd /Users/sam/carbone-reports
sh -n scripts/restore.sh && ! grep -n -- '--profile backup' scripts/restore.sh && echo restore-ок
```

- [ ] **Step 5: Интеграционные тесты агента**

Тесты проверяют образ, собранный по Step 1–4. До Step 1–4 они падают на сборке: в прежнем `Dockerfile` нет этапа `build`, а в `entrypoint.sh` нет режима `agent`.

`apps/backup-agent/package.json` — в `scripts` добавить:

```json
    "test:int": "vitest run --config vitest.int.config.ts",
```

`apps/backup-agent/vitest.int.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.int.test.ts'],
    environment: 'node',
    globalSetup: ['test/global-setup.ts'],
    testTimeout: 180_000,
    // Сборка образа агента при первом запуске — несколько минут.
    hookTimeout: 900_000,
    // Redis и флаг cr:maintenance общие для всех тестов.
    fileParallelism: false,
  },
});
```

`apps/backup-agent/test/global-setup.ts`:

```ts
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import {
  GenericContainer,
  Network,
  Wait,
  type StartedNetwork,
  type StartedTestContainer,
} from 'testcontainers';
import type { TestProject } from 'vitest/node';

/** Образ агента для тестов — из того же Dockerfile, что в compose и CI. */
const AGENT_IMAGE = 'carbone-reports-backup:it';
/** Тот же образ SeaweedFS и скрипт запуска, что у сервиса s3 (apps/api/test/images.ts). */
const S3_IMAGE = 'chrislusf/seaweedfs:4.48';
const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const S3_ENTRYPOINT = fileURLToPath(new URL('../../../docker/s3/entrypoint.sh', import.meta.url));

declare module 'vitest' {
  export interface ProvidedContext {
    agentImage: string;
    network: string;
    pg: { host: string; port: number; user: string; password: string };
    redis: { password: string; url: string };
    s3: { accessKeyId: string; secretAccessKey: string };
  }
}

let network: StartedNetwork | undefined;
let started: StartedTestContainer[] = [];

export default async function setup(project: TestProject) {
  const redisPassword = randomBytes(32).toString('hex');
  const s3Key = randomBytes(8).toString('hex');
  const s3Secret = randomBytes(16).toString('hex');
  network = await new Network().start();
  const [, pg, redis, s3] = await Promise.all([
    GenericContainer.fromDockerfile(ROOT, 'docker/backup/Dockerfile').build(AGENT_IMAGE, {
      deleteOnExit: false,
    }),
    new PostgreSqlContainer('postgres:17-alpine')
      .withNetwork(network)
      .withNetworkAliases('postgres')
      .start(),
    new GenericContainer('redis:7-alpine')
      .withCommand(['redis-server', '--requirepass', redisPassword, '--save', ''])
      .withNetwork(network)
      .withNetworkAliases('redis')
      .withExposedPorts(6379)
      .start(),
    new GenericContainer(S3_IMAGE)
      .withEnvironment({ S3_ACCESS_KEY_ID: s3Key, S3_SECRET_ACCESS_KEY: s3Secret })
      .withCopyFilesToContainer([{ source: S3_ENTRYPOINT, target: '/s3-entrypoint.sh', mode: 0o755 }])
      .withEntrypoint(['/s3-entrypoint.sh'])
      .withNetwork(network)
      .withNetworkAliases('s3')
      .withExposedPorts(8333)
      .withWaitStrategy(Wait.forHttp('/healthz', 8333))
      .start(),
  ]);
  started = [pg, redis, s3];
  project.provide('agentImage', AGENT_IMAGE);
  project.provide('network', network.getName());
  project.provide('pg', {
    host: pg.getHost(),
    port: pg.getPort(),
    user: pg.getUsername(),
    password: pg.getPassword(),
  });
  project.provide('redis', {
    password: redisPassword,
    url: `redis://:${redisPassword}@${redis.getHost()}:${redis.getMappedPort(6379)}`,
  });
  project.provide('s3', { accessKeyId: s3Key, secretAccessKey: s3Secret });
  return async () => {
    await Promise.all(started.map((c) => c.stop()));
    await network?.stop();
  };
}
```

`apps/backup-agent/test/helpers.ts`:

```ts
import { randomBytes, randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Redis } from 'ioredis';
import pg from 'pg';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { inject } from 'vitest';

/** Миграции приложения — те же, что Dockerfile кладёт в /agent/drizzle. */
export const MIGRATIONS = fileURLToPath(new URL('../../api/drizzle', import.meta.url));

export function pgUrl(db: string): string {
  const p = inject('pg');
  return `postgres://${p.user}:${p.password}@${p.host}:${p.port}/${db}`;
}

/** Миграции из apps/api/drizzle: все или первые n (схема старой версии приложения). */
export async function migrateTo(db: string, migrations: 'all' | number): Promise<void> {
  let folder = MIGRATIONS;
  let tmp: string | null = null;
  if (migrations !== 'all') {
    tmp = await mkdtemp(join(tmpdir(), 'cr-mig-'));
    await cp(MIGRATIONS, tmp, { recursive: true });
    const journalPath = join(tmp, 'meta/_journal.json');
    const journal = JSON.parse(await readFile(journalPath, 'utf8')) as { entries: unknown[] };
    journal.entries = journal.entries.slice(0, migrations);
    await writeFile(journalPath, JSON.stringify(journal));
    folder = tmp;
  }
  const pool = new pg.Pool({ connectionString: pgUrl(db), max: 1 });
  try {
    await migrate(drizzle(pool), { migrationsFolder: folder });
  } finally {
    await pool.end();
    if (tmp) await rm(tmp, { recursive: true, force: true });
  }
}

/** Новая база приложения (как app в compose) со всеми или первыми n миграциями. */
export async function createAppDatabase(migrations: 'all' | number = 'all'): Promise<string> {
  const name = `app_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Client({ connectionString: pgUrl('postgres') });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  await migrateTo(name, migrations);
  return name;
}

export const hostPool = (db: string) =>
  new pg.Pool({ connectionString: pgUrl(db), max: 2, application_name: 'it' });

export const hostRedis = () => new Redis(inject('redis').url, { maxRetriesPerRequest: 1 });

export interface OperationBody {
  id: string;
  type: 'backup' | 'restore';
  requestedBy: string;
  backup: string | null;
  phase: string;
  status: 'running' | 'succeeded' | 'failed';
  error: string | null;
  log: string[];
  recovery: { backup: string; preRestore: string | null } | null;
}

export interface StartedAgent {
  container: StartedTestContainer;
  call<T = unknown>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    token?: string,
  ): Promise<{ status: number; body: T }>;
  sh(script: string): Promise<{ exitCode: number; output: string }>;
  /** stdout и stderr контейнера с момента старта (docker compose logs backup). */
  logs(): string;
  waitIdle(timeoutMs?: number): Promise<OperationBody>;
  stop(): Promise<void>;
}

export async function startAgent(o: {
  db: string;
  bucket: string;
  env?: Record<string, string>;
  files?: { content: string; target: string; mode?: number }[];
}): Promise<StartedAgent> {
  const token = randomBytes(32).toString('hex');
  const p = inject('pg');
  const s3 = inject('s3');
  const container = await new GenericContainer(inject('agentImage'))
    .withNetworkMode(inject('network'))
    .withEnvironment({
      BACKUP_AGENT_TOKEN: token,
      REDIS_URL: `redis://:${inject('redis').password}@redis:6379`,
      PGHOST: 'postgres',
      PGUSER: p.user,
      PGPASSWORD: p.password,
      PGDATABASE: o.db,
      STORAGE_BACKEND: 's3',
      S3_ENDPOINT: 'http://s3:8333',
      S3_REGION: 'us-east-1',
      S3_BUCKET: o.bucket,
      S3_ACCESS_KEY_ID: s3.accessKeyId,
      S3_SECRET_ACCESS_KEY: s3.secretAccessKey,
      S3_FORCE_PATH_STYLE: 'true',
      BACKUP_AGENT_TERMINATE_DELAY_MS: '500',
      TZ: 'UTC',
      ...o.env,
    })
    .withCopyContentToContainer(
      (o.files ?? []).map((f) => ({ content: f.content, target: f.target, mode: f.mode ?? 0o755 })),
    )
    .withExposedPorts(8080)
    .withWaitStrategy(Wait.forHttp('/health', 8080))
    .start();
  let logs = '';
  (await container.logs()).on('data', (d: Buffer | string) => {
    logs += d.toString();
  });
  const base = `http://${container.getHost()}:${container.getMappedPort(8080)}`;
  const agent: StartedAgent = {
    container,
    async call<T>(method: 'GET' | 'POST', path: string, body?: unknown, tok = token) {
      const res = await fetch(base + path, {
        method,
        headers: {
          authorization: `Bearer ${tok}`,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, body: (text ? JSON.parse(text) : undefined) as T };
    },
    async sh(script) {
      const r = await container.exec(['sh', '-c', script]);
      return { exitCode: r.exitCode, output: r.output };
    },
    logs: () => logs,
    async waitIdle(timeoutMs = 120_000) {
      const until = Date.now() + timeoutMs;
      for (;;) {
        const r = await agent.call<OperationBody>('GET', '/operation');
        if (r.status === 200 && r.body.status !== 'running') return r.body;
        if (Date.now() > until) throw new Error(`операция не завершилась: ${JSON.stringify(r.body)}`);
        await new Promise((res) => setTimeout(res, 300));
      }
    },
    stop: async () => {
      await container.stop();
    },
  };
  // Бакет в compose создаёт API; здесь — rclone в контейнере агента теми же ключами.
  const mk = await rclone(agent, 'rclone mkdir "s3:$S3_BUCKET"');
  if (mk.exitCode !== 0) throw new Error(`бакет не создан: ${mk.output}`);
  return agent;
}

/** rclone внутри контейнера агента с настройками из его окружения (lib.sh: s3_env). */
export const rclone = (agent: StartedAgent, cmd: string) =>
  agent.sh(`. /backup/lib.sh && s3_env && ${cmd}`);
```

`apps/backup-agent/test/agent.int.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { bundledMigrationHashes, FUTURE_BACKUP } from '../src/migrations';
import {
  createAppDatabase,
  hostPool,
  hostRedis,
  migrateTo,
  MIGRATIONS,
  pgUrl,
  rclone,
  startAgent,
  type StartedAgent,
} from './helpers';

const KNOWN = bundledMigrationHashes(MIGRATIONS);
const codesIn = (logs: string) =>
  [...logs.matchAll(/КОД ВОССТАНОВЛЕНИЯ: ([A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4})/g)].map((m) => m[1]!);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const bucketName = () => `cr-${randomUUID()}`;

/** Скрипты-обёртки: фаза storage падает, пока есть /backups/.fail-storage. */
const FAILING_SCRIPTS = [
  { target: '/it-scripts/backup.sh', content: '#!/bin/sh\nexec /backup/backup.sh "$@"\n' },
  { target: '/it-scripts/lib.sh', content: '. /backup/lib.sh\n', mode: 0o644 },
  {
    target: '/it-scripts/entrypoint.sh',
    content:
      '#!/bin/sh\nif [ "${1:-}" = restore-storage ] && [ -f /backups/.fail-storage ]; then\n  echo "сбой восстановления хранилища (тест)" >&2\n  exit 1\nfi\nexec /backup/entrypoint.sh "$@"\n',
  },
];

let redis: Redis;
beforeAll(() => {
  redis = hostRedis();
});
afterAll(async () => {
  await redis.quit();
});

async function categories(pool: pg.Pool): Promise<string[]> {
  return (await pool.query<{ name: string }>('select name from categories order by name')).rows.map(
    (r) => r.name,
  );
}

async function list(agent: StartedAgent) {
  return (
    await agent.call<{ name: string; kind: string; status: string; lastMigration: string | null }[]>(
      'GET',
      '/backups',
    )
  ).body;
}

async function backupNow(agent: StartedAgent): Promise<string> {
  const before = new Set((await list(agent)).map((b) => b.name));
  const r = await agent.call<{ operationId: string }>('POST', '/backups', { requestedBy: 'it' });
  expect(r.status).toBe(202);
  expect(await agent.waitIdle()).toMatchObject({ id: r.body.operationId, type: 'backup', status: 'succeeded' });
  const created = (await list(agent)).find((b) => !before.has(b.name) && b.kind === 'regular');
  expect(created).toBeDefined();
  return created!.name;
}

describe.sequential('агент бэкапа в образе', () => {
  let agent: StartedAgent;
  let db: string;
  let pool: pg.Pool;

  beforeAll(async () => {
    db = await createAppDatabase();
    pool = hostPool(db);
    agent = await startAgent({ db, bucket: bucketName() });
  });
  afterAll(async () => {
    await pool.end();
    await agent.stop();
  });

  it('образ: Node ≥ 22 с часовыми поясами, rclone, flock, mountpoint, скрипты и миграции', async () => {
    const r = await agent.sh(
      `node -e "if (+process.versions.node.split('.')[0] < 22) process.exit(1); new Intl.DateTimeFormat('ru', { timeZone: 'Europe/Moscow' }).format(0)" && command -v rclone flock mountpoint pg_restore psql && ls /backup/entrypoint.sh /backup/backup.sh /backup/archive-storage.sh /backup/lib.sh /agent/drizzle/meta/_journal.json`,
    );
    expect(r.exitCode, r.output).toBe(0);
  });

  it('/health без токена; остальное — только с верным токеном', async () => {
    expect((await agent.call('GET', '/health', undefined, '')).status).toBe(200);
    expect((await agent.call('GET', '/backups', undefined, 'x'.repeat(64))).status).toBe(401);
  });

  it('неверный BACKUP_CRON, короткий токен, режим cron — выход с кодом 2 и понятным сообщением', async () => {
    const cron = await agent.sh('BACKUP_CRON="0 3 * *" BACKUP_AGENT_PORT=8099 node /agent/dist/main.js; echo "rc=$?"');
    expect(cron.output).toContain('BACKUP_CRON: ожидается 5 полей cron');
    expect(cron.output).toContain('rc=2');
    const tok = await agent.sh('BACKUP_AGENT_TOKEN=short-token node /agent/dist/main.js; echo "rc=$?"');
    expect(tok.output).toContain('BACKUP_AGENT_TOKEN: минимум 32 символа');
    expect(tok.output).not.toContain('short-token');
    expect(tok.output).toContain('rc=2');
    const mode = await agent.sh('/backup/entrypoint.sh cron; echo "rc=$?"');
    expect(mode.output).toContain('режимы: agent | now | restore-storage');
    expect(mode.output).toContain('rc=2');
  });

  it('бэкап и список: succeeded, в списке ok с последней миграцией; каталог .partial — partial', async () => {
    const name = await backupNow(agent);
    await agent.sh('mkdir -p /backups/2026-01-01T00-00-00Z.partial');
    const all = await list(agent);
    expect(all.find((b) => b.name === name)).toMatchObject({ kind: 'regular', status: 'ok', lastMigration: KNOWN.at(-1) });
    expect(all.find((b) => b.name === '2026-01-01T00-00-00Z.partial')).toMatchObject({ status: 'partial' });
  });

  it('409 при параллельной операции: второй запрос и ручной now; замок у постороннего процесса', async () => {
    expect((await agent.call('POST', '/backups', {})).status).toBe(202);
    const second = await agent.call<{ busy: { type: string; startedAt: string | null } }>('POST', '/backups', {});
    expect(second.status).toBe(409);
    expect(second.body.busy).toEqual({ type: 'backup', startedAt: expect.any(String) });
    const now = await agent.sh('/backup/entrypoint.sh now');
    expect(now.exitCode).toBe(75);
    expect(now.output).toContain('идёт другая операция с бэкапами');
    await agent.waitIdle();
    await agent.sh('(exec 9>>/backups/.op.lock; flock -n 9 && sleep 4) >/dev/null 2>&1 &');
    await sleep(500);
    const third = await agent.call<{ busy: unknown }>('POST', '/backups', {});
    expect(third.status).toBe(409);
    expect(third.body.busy).toEqual({ type: 'backup', startedAt: null });
    await sleep(4_000);
  });

  it('восстановление: база, файлы и Redis из бэкапа, сессии api завершены, pre-restore — последние 3, флаг снят', async () => {
    await pool.query("insert into categories (name) values ('до бэкапа')");
    await rclone(agent, 'printf v1 | rclone rcat "s3:$S3_BUCKET/templates/a.txt"');
    await sleep(1_100); // имя бэкапа — с точностью до секунды
    const name = await backupNow(agent);

    await pool.query("delete from categories where name = 'до бэкапа'");
    await pool.query("insert into categories (name) values ('после бэкапа')");
    await rclone(
      agent,
      'printf v2 | rclone rcat "s3:$S3_BUCKET/templates/a.txt" && printf x | rclone rcat "s3:$S3_BUCKET/stray.txt"',
    );
    await redis.set('cr:carbone:tpl:x', '{}');
    await agent.sh(
      'mkdir -p /backups/pre-restore-2020-01-01T00-00-00Z /backups/pre-restore-2020-01-02T00-00-00Z /backups/pre-restore-2020-01-03T00-00-00Z',
    );
    const api = new pg.Client({ connectionString: pgUrl(db), application_name: 'api' });
    api.on('error', () => {});
    await api.connect();

    const r = await agent.call('POST', `/backups/${name}/restore`, { requestedBy: 'admin' });
    expect(r.status).toBe(202);
    const op = await agent.waitIdle();
    expect(op).toMatchObject({ type: 'restore', requestedBy: 'admin', backup: name, status: 'succeeded', phase: 'done', recovery: null });
    const log = op.log.join('\n');
    expect(log).toContain('завершено сессий API: 1');
    expect(log).not.toContain(inject('s3').secretAccessKey);
    expect(log).not.toContain(inject('redis').password);

    expect(await categories(pool)).toContain('до бэкапа');
    expect(await categories(pool)).not.toContain('после бэкапа');
    expect((await rclone(agent, 'rclone cat "s3:$S3_BUCKET/templates/a.txt"')).output.trim()).toBe('v1');
    expect((await rclone(agent, 'rclone lsf -R --files-only "s3:$S3_BUCKET"')).output).not.toContain('stray.txt');
    expect(await redis.exists('cr:carbone:tpl:x')).toBe(0);
    expect(await redis.exists('cr:maintenance')).toBe(0);
    await expect(api.query('select 1')).rejects.toThrow();
    await api.end().catch(() => {});

    const pre = (await list(agent)).filter((b) => b.kind === 'pre-restore').map((b) => b.name);
    expect(pre).toHaveLength(3);
    expect(pre).not.toContain('pre-restore-2020-01-01T00-00-00Z');
    expect(pre).not.toContain('pre-restore-2020-01-02T00-00-00Z');

    // BACKUP_KEEP действует только на обычные бэкапы.
    await sleep(1_100);
    const keep = await agent.sh('BACKUP_KEEP=1 /backup/backup.sh');
    expect(keep.exitCode, keep.output).toBe(0);
    const after = await list(agent);
    expect(after.filter((b) => b.kind === 'regular' && b.status === 'ok')).toHaveLength(1);
    expect(after.filter((b) => b.kind === 'pre-restore')).toHaveLength(3);
  });

  it('бэкап «из будущего» — отказ на verify; база, pre-restore и флаг не тронуты', async () => {
    await sleep(1_100);
    const name = await backupNow(agent);
    const future = '2099-01-01T00-00-00Z';
    const cp = await agent.sh(
      `cp -r /backups/${name} /backups/${future} && sed -i 's/^last_migration=.*/last_migration=${'f'.repeat(64)}/' /backups/${future}/manifest.txt`,
    );
    expect(cp.exitCode, cp.output).toBe(0);
    const pre = (await list(agent)).filter((b) => b.kind === 'pre-restore').length;
    const cats = await categories(pool);
    expect((await agent.call('POST', `/backups/${future}/restore`, {})).status).toBe(202);
    const op = await agent.waitIdle();
    expect(op).toMatchObject({ status: 'failed', phase: 'verify', error: FUTURE_BACKUP, recovery: null });
    expect(await categories(pool)).toEqual(cats);
    expect((await list(agent)).filter((b) => b.kind === 'pre-restore').length).toBe(pre);
    expect(await redis.exists('cr:maintenance')).toBe(0);
  });

  it('бэкап старой схемы восстанавливается и доводится миграциями до текущей', async () => {
    const oldDb = await createAppDatabase(KNOWN.length - 1);
    const oldPool = hostPool(oldDb);
    const old = await startAgent({ db: oldDb, bucket: bucketName() });
    try {
      await oldPool.query("insert into categories (name) values ('старая версия')");
      const name = await backupNow(old);
      expect((await list(old)).find((b) => b.name === name)?.lastMigration).toBe(KNOWN.at(-2));
      await migrateTo(oldDb, 'all'); // обновление приложения
      await oldPool.query("insert into categories (name) values ('после обновления')");
      expect((await old.call('POST', `/backups/${name}/restore`, {})).status).toBe(202);
      expect(await old.waitIdle()).toMatchObject({ status: 'succeeded' });
      const n = await oldPool.query<{ n: number }>('select count(*)::int as n from drizzle.__drizzle_migrations');
      expect(n.rows[0]!.n).toBe(KNOWN.length);
      expect(await categories(oldPool)).toEqual(['старая версия']);
    } finally {
      await oldPool.end();
      await old.stop();
    }
  });

  it('сбой на этапе storage: флаг остаётся и возвращается после удаления, код только в журнале контейнера, повтор по коду', async () => {
    const failDb = await createAppDatabase();
    const failPool = hostPool(failDb);
    const a = await startAgent({
      db: failDb,
      bucket: bucketName(),
      env: { BACKUP_SCRIPTS_DIR: '/it-scripts' },
      files: FAILING_SCRIPTS,
    });
    try {
      await failPool.query("insert into categories (name) values ('в бэкапе')");
      const name = await backupNow(a);
      await failPool.query("insert into categories (name) values ('после бэкапа')");
      await a.sh('touch /backups/.fail-storage');
      expect((await a.call('POST', `/backups/${name}/restore`, { requestedBy: 'admin' })).status).toBe(202);
      let op = await a.waitIdle();
      expect(op).toMatchObject({
        status: 'failed',
        phase: 'storage',
        recovery: { backup: name, preRestore: expect.stringMatching(/^pre-restore-/) },
      });
      expect(JSON.parse((await redis.get('cr:maintenance'))!)).toMatchObject({ phase: 'storage', backup: name });

      const [code] = codesIn(a.logs());
      expect(code).toBeDefined();
      expect(op.log.join('\n')).not.toContain(code);
      expect((await a.sh('cat /backups/.op/state.json')).output).not.toContain(code!);

      // Redis перезапущен (ключа нет) — агент возвращает флаг не позже чем через 5 с.
      await redis.del('cr:maintenance');
      await sleep(6_000);
      expect(await redis.exists('cr:maintenance')).toBe(1);

      expect((await a.call('POST', '/backups', {})).status).toBe(409);
      expect((await a.call('POST', '/recovery', { code: 'AAAA-AAAA-AAAA', target: 'same' })).status).toBe(403);

      // Причина не устранена: повтор снова падает, печатается новый код.
      expect((await a.call('POST', '/recovery', { code, target: 'same' })).status).toBe(202);
      op = await a.waitIdle();
      expect(op).toMatchObject({ status: 'failed', phase: 'storage', requestedBy: 'recovery-code' });
      const codes = codesIn(a.logs());
      expect(codes).toHaveLength(2);

      await a.sh('rm /backups/.fail-storage');
      expect((await a.call('POST', '/recovery', { code: codes[1], target: 'same' })).status).toBe(202);
      op = await a.waitIdle();
      expect(op).toMatchObject({ status: 'succeeded', recovery: null });
      expect(await redis.exists('cr:maintenance')).toBe(0);
      expect(await categories(failPool)).toEqual(['в бэкапе']);
      expect((await a.call('POST', '/recovery', { code: codes[1], target: 'same' })).status).toBe(409);
    } finally {
      await failPool.end();
      await a.stop();
    }
  });
});
```

- [ ] **Step 6: Запуск — должно пройти**

```bash
cd /Users/sam/carbone-reports
source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null && pnpm --filter @carbone-reports/backup-agent test && pnpm --filter @carbone-reports/backup-agent test:int
docker image ls carbone-reports-backup:it --format '{{.Size}}'      # ориентир: ≈ 350–450 MB
df -h /System/Volumes/Data | tail -1
```
Expected: PASS — все 9 тестов `agent.int.test.ts` и `compose.test.ts`.
- Если сборка упала на `pnpm install --frozen-lockfile`, сначала проверить, что `pnpm-lock.yaml` из Task 1 закоммичен вместе с `apps/backup-agent/package.json`.
- Если в образе нет `flock` (тест «образ…»), добавить в `apk add` пакет `util-linux-misc` и повторить. Busybox в `postgres:17-alpine` обычно содержит `flock`.

- [ ] **Step 7: CI**

`.github/workflows/ci.yml`, задача `integration`: комментарий и таймаут заменить на:

```yaml
    # API: все файлы на local, затем выбранные потоки на S3 (SeaweedFS в testcontainers).
    # Агент бэкапа: сборка образа docker/backup/Dockerfile и тесты в контейнере.
    timeout-minutes: 45
```

Шаг `pnpm test:int` уже запускает `pnpm -r test:int`, а в нём и агента. Задача `images` собирает `docker/backup/Dockerfile` с `context: .` — менять не нужно.

- [ ] **Step 8: Гейты и коммит**

```bash
cd /Users/sam/carbone-reports
source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null && pnpm exec prettier --write apps/backup-agent docker-compose.yml .github/workflows/ci.yml && pnpm typecheck && pnpm lint && pnpm exec prettier --check . && pnpm test && pnpm --filter @carbone-reports/backup-agent test:int
docker compose config --quiet && echo compose-ок       # .env с BACKUP_AGENT_TOKEN; без вывода значений
git status --short                                    # .env, certs/, backups/ не в списке
git add docker/backup .dockerignore docker-compose.yml .env.example scripts/restore.sh .github/workflows/ci.yml apps/backup-agent
git commit -m "feat(backup): agent image (postgres:17-alpine + rclone + node), entrypoint agent/now/restore-storage, backup service in the stack, restore.sh resolves admin restores

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

`docker compose config --quiet` требует `BACKUP_AGENT_TOKEN` в `.env`. Если его нет, добавить без вывода значения: `grep -q '^BACKUP_AGENT_TOKEN=.' .env || printf 'BACKUP_AGENT_TOKEN=%s\n' "$(openssl rand -hex 32)" >> .env`.

## Task 5: API: настройки агента, `application_name`, клиент агента, модуль `backups`, признак `features.backups` (§26.2, §26.3)

**Files:**
- Modify: `packages/shared/src/index.ts` (в конец), `packages/shared/src/index.test.ts`
- Modify: `apps/api/src/config.ts`, `apps/api/src/config.test.ts`
- Modify: `apps/api/src/db/client.ts:7-11`
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/src/deps.ts`
- Create: `apps/api/src/modules/backups/agent-client.ts`, `apps/api/src/modules/backups/routes.ts`
- Modify: `apps/api/src/modules/auth/routes.ts` (ответы `login` и `me`)
- Modify: `apps/api/src/app.ts` (регистрация маршрутов)
- Modify: `apps/api/test/helpers.ts` (`testConfig`, `createTestApp`)
- Create: `apps/api/test/fake-agent.ts`, `apps/api/test/backups.int.test.ts`

**Interfaces:**
- Consumes: HTTP агента (Task 3): `GET /backups`, `POST /backups {requestedBy}`, `POST /backups/:name/restore {requestedBy}`, `GET /operation` (200 | 204); `makeGuards` (`requireAdmin`), `currentUser`, `AppError`.
- Produces:
  - shared: `BACKUP_NAME_RE`, `BackupNameParams`, `type BackupDto`, `type BackupPhase`, `type RecoveryTargets`, `type BackupOperationDto`, `type MaintenanceStatus`, `RecoveryBody` (+ тип), `type Features { backups: boolean }`;
  - `Config.backupAgent: { url: string; token: string } | null`;
  - `createDb(url, onError?)` — пул с `application_name: 'api'` и обработчиком `error`;
  - `interface AgentResponse { status: number; body: unknown }`, `interface AgentClient { request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<AgentResponse> }`, `createAgentClient({ url, token, timeoutMs? = 10_000 }): AgentClient`, `agentUnavailable(internal?)` (502 `backup_agent_unavailable` «Агент бэкапа недоступен»);
  - `AppDeps.backupAgent: AgentClient | null`;
  - `backupsDisabled()` (404 `backups_disabled`), `registerBackupRoutes(app, deps, guards)`;
  - `/api/auth/login` и `/api/auth/me` отвечают `{ id, login, role, features: { backups } }`;
  - тестовый `startFakeAgent(): Promise<FakeAgent>` (`url`, `token`, `requests`, `respond(method, path, r)`, `close()`).

Правила ответа API:
- агент ответил 401 (токены разошлись) или 5xx, не ответил за 10 с, ответил не-JSON → 502 `backup_agent_unavailable`; причина пишется только в журнал (`AppError.internal`), без токена;
- остальные статусы агента (202, 204, 400, 403, 404, 409) с телом передаются клиенту как есть.

Конфигурация: адрес без токена или токен короче 32 символов — ошибка при старте; токен без адреса — функция выключена (так в `.env.example` для API на хосте).

- [ ] **Step 1: Падающие тесты**

`packages/shared/src/index.test.ts` — в импорт из `./index` добавить `BACKUP_NAME_RE` и `RecoveryBody`, в конец файла:

```ts
describe('бэкапы', () => {
  it('BACKUP_NAME_RE — шаблон имени из §26.1', () => {
    expect(BACKUP_NAME_RE.test('2026-10-08T03-00-00Z')).toBe(true);
    expect(BACKUP_NAME_RE.test('pre-restore-2026-10-08T03-00-00Z')).toBe(true);
    for (const bad of ['2026-10-08T03-00-00Z.partial', '../x', '2026-10-08 03-00-00Z', ''])
      expect(BACKUP_NAME_RE.test(bad)).toBe(false);
  });
  it('RecoveryBody: код и цель same | pre-restore', () => {
    expect(RecoveryBody.parse({ code: ' ABCD-EFGH-IJKL ', target: 'same' })).toEqual({
      code: 'ABCD-EFGH-IJKL',
      target: 'same',
    });
    expect(RecoveryBody.safeParse({ code: '', target: 'same' }).success).toBe(false);
    expect(RecoveryBody.safeParse({ code: 'X', target: 'other' }).success).toBe(false);
  });
});
```

`apps/api/src/config.test.ts` — в конец файла:

```ts
describe('loadConfig: агент бэкапа', () => {
  const token = 'b'.repeat(32);
  it('без BACKUP_AGENT_URL функция выключена (токен без адреса не мешает)', () => {
    expect(loadConfig(base).backupAgent).toBeNull();
    expect(loadConfig({ ...base, BACKUP_AGENT_URL: '', BACKUP_AGENT_TOKEN: token }).backupAgent).toBeNull();
  });
  it('адрес и токен; завершающий / убирается', () => {
    expect(
      loadConfig({ ...base, BACKUP_AGENT_URL: 'http://backup:8080/', BACKUP_AGENT_TOKEN: token }).backupAgent,
    ).toEqual({ url: 'http://backup:8080', token });
  });
  it('адрес без токена или короткий токен — ошибка; значение токена в сообщение не попадает', () => {
    expect(() => loadConfig({ ...base, BACKUP_AGENT_URL: 'http://backup:8080' })).toThrow(
      'BACKUP_AGENT_TOKEN: обязателен при BACKUP_AGENT_URL',
    );
    let message = '';
    try {
      loadConfig({ ...base, BACKUP_AGENT_URL: 'http://backup:8080', BACKUP_AGENT_TOKEN: 'short-secret-token' });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('BACKUP_AGENT_TOKEN: минимум 32 символа');
    expect(message).not.toContain('short-secret-token');
  });
  it('адрес — только http(s)-URL', () => {
    expect(() => loadConfig({ ...base, BACKUP_AGENT_URL: 'backup:8080', BACKUP_AGENT_TOKEN: token })).toThrow(
      'BACKUP_AGENT_URL: нужен URL, например http://backup:8080',
    );
  });
});
```

`apps/api/test/fake-agent.ts`:

```ts
import Fastify from 'fastify';

export interface FakeAgentRequest {
  method: string;
  path: string;
  auth: string | undefined;
  body: unknown;
}

export interface FakeResponse {
  status: number;
  body?: unknown;
  /** Тело как есть (не JSON). */
  raw?: string;
  delayMs?: number;
}

export interface FakeAgent {
  url: string;
  token: string;
  requests: FakeAgentRequest[];
  respond(method: 'GET' | 'POST', path: string, r: FakeResponse): void;
  close(): Promise<void>;
}

/** Агент бэкапа для тестов API: настоящий HTTP на 127.0.0.1, ответы задаёт тест (по умолчанию 404). */
export async function startFakeAgent(token = 'a'.repeat(40)): Promise<FakeAgent> {
  const app = Fastify({ logger: false });
  const requests: FakeAgentRequest[] = [];
  const responses = new Map<string, FakeResponse>();
  app.all('/*', async (req, reply) => {
    const path = req.url.split('?')[0]!;
    requests.push({ method: req.method, path, auth: req.headers.authorization, body: req.body });
    const r = responses.get(`${req.method} ${path}`);
    if (!r) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'нет ответа в тесте' } });
    if (r.delayMs) await new Promise((res) => setTimeout(res, r.delayMs));
    if (r.raw !== undefined) return reply.code(r.status).type('text/plain').send(r.raw);
    return r.body === undefined ? reply.code(r.status).send() : reply.code(r.status).send(r.body);
  });
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  return {
    url,
    token,
    requests,
    respond: (method, path, r) => void responses.set(`${method} ${path}`, r),
    close: () => app.close(),
  };
}
```

`apps/api/test/backups.int.test.ts`:

```ts
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAgentClient } from '../src/modules/backups/agent-client';
import { startFakeAgent, type FakeAgent } from './fake-agent';
import { createTestApp, loginAs, type TestApp } from './helpers';

const NAME = '2026-10-08T03-00-00Z';
const BACKUPS = [
  {
    name: NAME,
    createdAt: '2026-10-08T03:00:00Z',
    dbSize: 1,
    storageSize: 2,
    lastMigration: 'a'.repeat(64),
    kind: 'regular',
    status: 'ok',
  },
];
const UNAVAILABLE = { error: { code: 'backup_agent_unavailable', message: 'Агент бэкапа недоступен' } };
const ROUTES = [
  ['GET', '/api/admin/backups'],
  ['POST', '/api/admin/backups'],
  ['POST', `/api/admin/backups/${NAME}/restore`],
  ['GET', '/api/admin/backups/operation'],
] as const;

describe('бэкапы в админке: прокси к агенту', () => {
  let agent: FakeAgent;
  let t: TestApp;
  let admin: { cookie: string; user: { login: string } };
  let user: string;

  beforeAll(async () => {
    agent = await startFakeAgent();
    // Тайм-аут короче 10 с только для теста «агент не ответил вовремя».
    t = await createTestApp({ backupAgent: createAgentClient({ url: agent.url, token: agent.token, timeoutMs: 500 }) });
    admin = await loginAs(t, 'admin');
    user = (await loginAs(t, 'user')).cookie;
  });
  afterAll(async () => {
    await t.close();
    await agent.close();
  });

  it('не-admin — 403, без входа — 401; агент не вызывается', async () => {
    for (const [method, url] of ROUTES) {
      expect((await t.app.inject({ method, url, headers: { cookie: user } })).statusCode).toBe(403);
      expect((await t.app.inject({ method, url })).statusCode).toBe(401);
    }
    expect(agent.requests).toEqual([]);
  });

  it('GET /api/admin/backups — список агента; токен передан в Authorization', async () => {
    agent.respond('GET', '/backups', { status: 200, body: BACKUPS });
    const r = await t.app.inject({ method: 'GET', url: '/api/admin/backups', headers: { cookie: admin.cookie } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual(BACKUPS);
    expect(agent.requests.at(-1)).toEqual({ method: 'GET', path: '/backups', auth: `Bearer ${agent.token}`, body: undefined });
  });

  it('POST /api/admin/backups — 202; requestedBy = логин админа', async () => {
    agent.respond('POST', '/backups', { status: 202, body: { operationId: 'op1' } });
    const r = await t.app.inject({ method: 'POST', url: '/api/admin/backups', headers: { cookie: admin.cookie } });
    expect(r.statusCode).toBe(202);
    expect(r.json()).toEqual({ operationId: 'op1' });
    expect(agent.requests.at(-1)).toMatchObject({ method: 'POST', path: '/backups', body: { requestedBy: admin.user.login } });
  });

  it('restore: неверное имя — 400 до агента; верное — 202 с логином', async () => {
    const before = agent.requests.length;
    for (const bad of ['..%2F..%2Fetc', `${NAME}.partial`, 'latest']) {
      const r = await t.app.inject({ method: 'POST', url: `/api/admin/backups/${bad}/restore`, headers: { cookie: admin.cookie } });
      expect(r.statusCode).toBe(400);
    }
    expect(agent.requests.length).toBe(before);
    agent.respond('POST', `/backups/${NAME}/restore`, { status: 202, body: { operationId: 'op2' } });
    const r = await t.app.inject({ method: 'POST', url: `/api/admin/backups/${NAME}/restore`, headers: { cookie: admin.cookie } });
    expect(r.statusCode).toBe(202);
    expect(agent.requests.at(-1)).toMatchObject({ path: `/backups/${NAME}/restore`, body: { requestedBy: admin.user.login } });
  });

  it('ответы агента 204, 404 и 409 передаются как есть', async () => {
    agent.respond('GET', '/operation', { status: 204 });
    const op = await t.app.inject({ method: 'GET', url: '/api/admin/backups/operation', headers: { cookie: admin.cookie } });
    expect(op.statusCode).toBe(204);
    expect(op.body).toBe('');

    const busy = {
      error: { code: 'BUSY', message: 'уже выполняется другая операция с бэкапами' },
      busy: { type: 'restore', startedAt: '2026-10-08T10:00:00.000Z' },
    };
    agent.respond('POST', '/backups', { status: 409, body: busy });
    const r = await t.app.inject({ method: 'POST', url: '/api/admin/backups', headers: { cookie: admin.cookie } });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual(busy);

    agent.respond('POST', `/backups/${NAME}/restore`, { status: 404, body: { error: { code: 'NOT_FOUND', message: 'бэкап не найден' } } });
    const nf = await t.app.inject({ method: 'POST', url: `/api/admin/backups/${NAME}/restore`, headers: { cookie: admin.cookie } });
    expect(nf.statusCode).toBe(404);
    expect(nf.json().error.message).toBe('бэкап не найден');
  });

  it('агент отклонил токен, упал (5xx), ответил не-JSON или не уложился в срок — 502; токена в ответе нет', async () => {
    const cases = [
      { status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'требуется токен агента' } } },
      { status: 500, body: { error: { code: 'INTERNAL', message: 'x' } } },
      { status: 200, raw: '<html>' },
      { status: 200, body: BACKUPS, delayMs: 1_500 },
    ];
    for (const c of cases) {
      agent.respond('GET', '/backups', c);
      const r = await t.app.inject({ method: 'GET', url: '/api/admin/backups', headers: { cookie: admin.cookie } });
      expect(r.statusCode).toBe(502);
      expect(r.json()).toEqual(UNAVAILABLE);
      expect(r.body).not.toContain(agent.token);
    }
  });

  it('features.backups = true в /api/auth/me и в ответе входа', async () => {
    const me = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: admin.cookie } });
    expect(me.json()).toMatchObject({ login: admin.user.login, role: 'admin', features: { backups: true } });
    const fresh = await loginAs(t, 'user');
    const login = await t.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { login: fresh.user.login, password: 'password123' },
    });
    expect(login.json()).toMatchObject({ features: { backups: true } });
  });

  it('соединения API помечены application_name=api и переживают pg_terminate_backend', async () => {
    expect((await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: admin.cookie } })).statusCode).toBe(200);
    const c = new pg.Client({ connectionString: t.deps.config.databaseUrl });
    await c.connect();
    const r = await c.query<{ n: number }>(
      `select count(pg_terminate_backend(pid))::int as n from pg_stat_activity
       where application_name = 'api' and datname = current_database() and pid <> pg_backend_pid()`,
    );
    await c.end();
    expect(r.rows[0]!.n).toBeGreaterThan(0);
    await new Promise((res) => setTimeout(res, 300));
    // Пул выбросил завершённые соединения (без обработчика error процесс бы упал) и открыл новые.
    expect((await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: admin.cookie } })).statusCode).toBe(200);
  });
});

describe('бэкапы в админке: агент выключен или недоступен', () => {
  it('без BACKUP_AGENT_URL — 404 backups_disabled; features.backups = false', async () => {
    const t = await createTestApp();
    try {
      const { cookie } = await loginAs(t, 'admin');
      const r = await t.app.inject({ method: 'GET', url: '/api/admin/backups', headers: { cookie } });
      expect(r.statusCode).toBe(404);
      expect(r.json().error.code).toBe('backups_disabled');
      const me = await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
      expect(me.json().features).toEqual({ backups: false });
    } finally {
      await t.close();
    }
  });

  it('агент не слушает порт — 502 backup_agent_unavailable', async () => {
    const gone = await startFakeAgent();
    await gone.close();
    const t = await createTestApp({ backupAgent: createAgentClient({ url: gone.url, token: gone.token }) });
    try {
      const { cookie } = await loginAs(t, 'admin');
      const r = await t.app.inject({ method: 'POST', url: '/api/admin/backups', headers: { cookie } });
      expect(r.statusCode).toBe(502);
      expect(r.json()).toEqual(UNAVAILABLE);
    } finally {
      await t.close();
    }
  });
});
```

- [ ] **Step 2: Запуск — должно упасть**

Run: `source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null && pnpm --filter @carbone-reports/shared test; pnpm --filter @carbone-reports/api test; pnpm --filter @carbone-reports/api exec vitest run --config vitest.int.config.ts test/backups.int.test.ts`
Expected: FAIL — нет `BACKUP_NAME_RE`/`RecoveryBody` в shared, `backupAgent` в конфигурации, модуля `../src/modules/backups/agent-client`.

- [ ] **Step 3: shared, конфигурация, пул**

`packages/shared/src/index.ts` — в конец:

```ts
// ---- Бэкапы (§26) ----

/** Имя бэкапа, из которого можно восстановить (§26.1). */
export const BACKUP_NAME_RE = /^(pre-restore-)?\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/;

export const BackupNameParams = z.object({
  name: z.string().regex(BACKUP_NAME_RE, 'неверное имя бэкапа'),
});
export type BackupNameParams = z.infer<typeof BackupNameParams>;

export interface BackupDto {
  name: string;
  /** ISO-время UTC. */
  createdAt: string;
  dbSize: number | null;
  storageSize: number | null;
  lastMigration: string | null;
  kind: 'regular' | 'pre-restore';
  status: 'ok' | 'partial';
}

export type BackupPhase =
  | 'backup'
  | 'verify'
  | 'pre-backup'
  | 'maintenance'
  | 'db'
  | 'migrate'
  | 'storage'
  | 'redis'
  | 'done';

/** Цели повтора в состоянии «требуется восстановление» (§26.4). */
export interface RecoveryTargets {
  backup: string;
  preRestore: string | null;
}

export interface BackupOperationDto {
  id: string;
  type: 'backup' | 'restore';
  /** cron | логин | recovery-code */
  requestedBy: string;
  backup: string | null;
  phase: BackupPhase;
  status: 'running' | 'succeeded' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  /** Хвост журнала операции, до 500 строк. */
  log: string[];
  recovery: RecoveryTargets | null;
}

export type MaintenanceStatus =
  | { active: false }
  | {
      active: true;
      phase: BackupPhase;
      startedAt: string;
      backup: string;
      recovery: RecoveryTargets | null;
    };

export const RecoveryBody = z.object({
  code: z.string().trim().min(1, 'введите код восстановления').max(64),
  target: z.enum(['same', 'pre-restore']),
});
export type RecoveryBody = z.infer<typeof RecoveryBody>;

/** Включённые функции — в ответах /api/auth/me и /api/auth/login. */
export interface Features {
  backups: boolean;
}
```

`apps/api/src/config.ts`:
- в `Env` после `LDAP_TLS_REJECT_UNAUTHORIZED` добавить:

  ```ts
      // Агент бэкапа (§26.3): без адреса управление бэкапами в админке выключено.
      BACKUP_AGENT_URL: z
        .string()
        .refine(
          (v) => v === '' || (/^https?:\/\//.test(v) && URL.canParse(v)),
          'нужен URL, например http://backup:8080',
        )
        .optional(),
      BACKUP_AGENT_TOKEN: z.string().optional(),
  ```

- после последнего `.superRefine(...)` (S3) дописать ещё один:

  ```ts
    .superRefine((e, ctx) => {
      if (!e.BACKUP_AGENT_URL) return;
      // Только имя переменной и правило — значение токена в сообщение не попадает.
      if (!e.BACKUP_AGENT_TOKEN)
        ctx.addIssue({ code: 'custom', path: ['BACKUP_AGENT_TOKEN'], message: 'обязателен при BACKUP_AGENT_URL' });
      else if (e.BACKUP_AGENT_TOKEN.length < 32)
        ctx.addIssue({ code: 'custom', path: ['BACKUP_AGENT_TOKEN'], message: 'минимум 32 символа' });
    });
  ```

  (у предыдущего `.superRefine` убрать завершающую `;`).

- в `interface Config` после `ldap: LdapConfig | null;`:

  ```ts
    /** Агент бэкапа; null — управление бэкапами выключено. Токен не логируется. */
    backupAgent: { url: string; token: string } | null;
  ```

- в `loadConfig` после блока `ldap: …,`:

  ```ts
      backupAgent: e.BACKUP_AGENT_URL
        ? { url: e.BACKUP_AGENT_URL.replace(/\/$/, ''), token: e.BACKUP_AGENT_TOKEN! }
        : null,
  ```

`apps/api/src/db/client.ts` — `createDb` целиком:

```ts
export function createDb(url: string, onError: (err: Error) => void = () => {}) {
  // application_name: по нему агент бэкапа завершает сессии API перед заменой базы (§26.2).
  const pool = new pg.Pool({ connectionString: url, max: 10, application_name: 'api' });
  // Простаивающее соединение, завершённое pg_terminate_backend, пул выбрасывает сам; без
  // обработчика событие error уронило бы процесс.
  pool.on('error', onError);
  const db = drizzle(pool, { schema });
  return { db, pool };
}
```

- [ ] **Step 4: Клиент агента и маршруты**

`apps/api/src/modules/backups/agent-client.ts`:

```ts
import { AppError } from '../../lib/errors';

export interface AgentResponse {
  status: number;
  /** undefined — пустое тело (204). */
  body: unknown;
}

export interface AgentClient {
  request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<AgentResponse>;
}

/** 502 (§26.3). internal — причина только для журнала API, без токена. */
export const agentUnavailable = (internal?: unknown) =>
  new AppError('backup_agent_unavailable', 502, 'Агент бэкапа недоступен', undefined, internal);

export function createAgentClient(o: { url: string; token: string; timeoutMs?: number }): AgentClient {
  const base = o.url.replace(/\/$/, '');
  const timeoutMs = o.timeoutMs ?? 10_000;
  return {
    async request(method, path, body) {
      let status: number;
      let text: string;
      try {
        const res = await fetch(`${base}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${o.token}`,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        status = res.status;
        text = await res.text();
      } catch (e) {
        throw agentUnavailable(e instanceof Error ? e.message : String(e));
      }
      if (status === 401) throw agentUnavailable('агент отклонил BACKUP_AGENT_TOKEN');
      if (status >= 500) throw agentUnavailable(`агент ответил HTTP ${status}`);
      if (!text) return { status, body: undefined };
      try {
        return { status, body: JSON.parse(text) as unknown };
      } catch {
        throw agentUnavailable(`агент ответил не JSON (HTTP ${status})`);
      }
    },
  };
}
```

`apps/api/src/modules/backups/routes.ts`:

```ts
import { BackupNameParams } from '@carbone-reports/shared';
import type { App } from '../../app';
import type { AppDeps } from '../../deps';
import { AppError } from '../../lib/errors';
import { currentUser, type Guards } from '../auth/guards';
import type { AgentClient } from './agent-client';

export const backupsDisabled = () =>
  new AppError(
    'backups_disabled',
    404,
    'управление бэкапами выключено: задайте BACKUP_AGENT_URL и BACKUP_AGENT_TOKEN',
  );

/** Прокси к агенту бэкапа (§26.3), только роль admin. */
export function registerBackupRoutes(app: App, deps: AppDeps, guards: Guards): void {
  const pre = { preHandler: guards.requireAdmin };
  const agent = (): AgentClient => {
    if (!deps.backupAgent) throw backupsDisabled();
    return deps.backupAgent;
  };

  app.get('/api/admin/backups', pre, async (_req, reply) => {
    const r = await agent().request('GET', '/backups');
    return reply.status(r.status).send(r.body);
  });

  app.post('/api/admin/backups', pre, async (req, reply) => {
    const login = currentUser(req).login;
    const r = await agent().request('POST', '/backups', { requestedBy: login });
    if (r.status === 202) req.log.info({ login }, 'бэкап запущен из админки');
    return reply.status(r.status).send(r.body);
  });

  app.post(
    '/api/admin/backups/:name/restore',
    { ...pre, schema: { params: BackupNameParams } },
    async (req, reply) => {
      const login = currentUser(req).login;
      const { name } = req.params;
      const r = await agent().request('POST', `/backups/${encodeURIComponent(name)}/restore`, {
        requestedBy: login,
      });
      if (r.status === 202) req.log.warn({ login, backup: name }, 'восстановление из бэкапа запущено из админки');
      return reply.status(r.status).send(r.body);
    },
  );

  app.get('/api/admin/backups/operation', pre, async (_req, reply) => {
    const r = await agent().request('GET', '/operation');
    return reply.status(r.status).send(r.body);
  });
}
```

`apps/api/src/deps.ts` — импорт `import type { AgentClient } from './modules/backups/agent-client';` и в `AppDeps` после `ldap`:

```ts
  /** Агент бэкапа (§26.3); null — управление бэкапами в админке выключено. */
  backupAgent: AgentClient | null;
```

`apps/api/src/app.ts` — импорт `import { registerBackupRoutes } from './modules/backups/routes';` и после `registerOnlyOfficeRoutes(app, deps, guards);`:

```ts
  registerBackupRoutes(app, deps, guards);
```

`apps/api/src/modules/auth/routes.ts`:
- импорт `type Features` из `@carbone-reports/shared` (рядом с `LoginBody`) и `type SessionUser` уже есть;
- в начале `registerAuthRoutes`:

  ```ts
    // Признак включённых функций для меню web (§26.3): в ответах входа и /api/auth/me.
    const withFeatures = (user: SessionUser): SessionUser & { features: Features } => ({
      ...user,
      features: { backups: deps.backupAgent !== null },
    });
  ```

- в обработчике `/api/auth/login` оба `return user;` заменить на `return withFeatures(user);`;
- `app.get('/api/auth/me', { preHandler: guards.requireUser }, async (req) => currentUser(req));` заменить на:

  ```ts
  app.get('/api/auth/me', { preHandler: guards.requireUser }, async (req) =>
    withFeatures(currentUser(req)),
  );
  ```

`apps/api/src/server.ts`:
- импорт `import { createAgentClient } from './modules/backups/agent-client';`;
- `const { db, pool } = createDb(config.databaseUrl);` → `const { db, pool } = createDb(config.databaseUrl, (err) => console.error('db pool', err.message));`;
- `new pg.Pool({ connectionString: config.databaseUrl, max: 2 })` → `new pg.Pool({ connectionString: config.databaseUrl, max: 2, application_name: 'api' })`;
- `new pg.Pool({ connectionString: config.databaseUrl, max: 3 })` → `new pg.Pool({ connectionString: config.databaseUrl, max: 3, application_name: 'api' })`;
- в `deps` после `ldap: …,`:

  ```ts
    backupAgent: config.backupAgent ? createAgentClient(config.backupAgent) : null,
  ```

`apps/api/test/helpers.ts`:
- в `testConfig` после `ldap: null,` — `backupAgent: null,`;
- в `createTestApp` в объекте `deps` после `ldap: null,` — `backupAgent: null,`.

- [ ] **Step 5: Запуск — должно пройти**

```bash
cd /Users/sam/carbone-reports
source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null && pnpm --filter @carbone-reports/shared test && pnpm --filter @carbone-reports/api test && pnpm --filter @carbone-reports/api exec vitest run --config vitest.int.config.ts test/backups.int.test.ts test/auth.int.test.ts test/ldap-login.int.test.ts
```
Expected: PASS.

- [ ] **Step 6: Гейты и коммит**

```bash
cd /Users/sam/carbone-reports
source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null && pnpm exec prettier --write packages/shared apps/api && pnpm typecheck && pnpm lint && pnpm exec prettier --check . && pnpm test && pnpm --filter @carbone-reports/api test:int
git add packages/shared apps/api
git commit -m "feat(api): backups admin proxy to the backup agent, features.backups, application_name=api and pool error handler

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Task 6: API: режим обслуживания, `/api/maintenance`, повтор по коду с лимитом (§26.3, §26.4)

**Files:**
- Create: `apps/api/src/modules/maintenance/flag.ts`, `apps/api/src/modules/maintenance/flag.test.ts`
- Create: `apps/api/src/modules/maintenance/routes.ts`
- Modify: `apps/api/src/app.ts` (регистрация до остальных маршрутов)
- Create: `apps/api/test/maintenance.int.test.ts`

**Interfaces:**
- Consumes: Task 5 (`AgentClient`, `createAgentClient`, `backupsDisabled`, `RecoveryBody`, `MaintenanceStatus`, `RecoveryTargets`, `BackupPhase`, `startFakeAgent`); `AppDeps.redis`, `AppDeps.sources.closeAll()`; агент: `GET /operation` (поле `recovery`), `POST /recovery {code, target}`.
- Produces:
  - `MAINTENANCE_KEY = 'cr:maintenance'`, `interface MaintenanceFlag { phase: string; startedAt: string; backup: string }`;
  - `watchMaintenance(redis: Redis | null, o?: { ttlMs?: number; onEnd?: () => void; now?: () => number }): { get(): Promise<MaintenanceFlag | null>; stop(): void }`;
  - `registerMaintenance(app, deps)`; `RETRY_LIMIT = 10`, `RETRY_WINDOW_MS = 900_000`;
  - 503 `{ error: { code: 'maintenance', message: 'идёт восстановление из бэкапа, повторите позже', details: { phase } } }`;
  - `GET /api/maintenance` → `MaintenanceStatus`;
  - `POST /api/maintenance/retry {code, target}` → ответ агента как есть | 429 `TOO_MANY_ATTEMPTS` | 404 `backups_disabled` | 400 `VALIDATION`.

Поведение:
- **Кэш.** Значение флага кэшируется в процессе на 1 с (§26.3): запрос идёт в Redis не чаще раза в секунду, одновременные запросы делят один `GET`. Тот же `get()` раз в секунду вызывает таймер (`unref`). Поэтому экземпляр API замечает снятие флага, даже если в это время к нему не было запросов.
- **Снятие флага** (было значение → стало `null`) вызывает `onEnd`. Он закрывает пулы источников данных (`sources.closeAll()`): после восстановления их настройки и пароли в базе могли стать другими. При ошибке Redis значение — `null` (fail-open), и это тоже «снятие»: лишний сброс пулов безвреден.
- **Белый список** сравнивается по методу и пути без query.
- **Лимит повтора:** `MULTI INCR cr:rl-retry:<ip>` + `PEXPIRE … NX`. Ошибка Redis → лимит пропускается (§26.3). IP — `req.ip` (доверие одному хопу nginx, как у лимита входа).

- [ ] **Step 1: Падающие тесты**

`apps/api/src/modules/maintenance/flag.test.ts`:

```ts
import type { Redis } from 'ioredis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAINTENANCE_KEY, watchMaintenance } from './flag';

const FLAG = JSON.stringify({ phase: 'db', startedAt: '2026-10-08T10:00:00.000Z', backup: '2026-10-08T03-00-00Z' });

function fakeRedis(values: (string | null | Error)[]) {
  let i = 0;
  const get = vi.fn(async (key: string) => {
    expect(key).toBe(MAINTENANCE_KEY);
    const v = values[Math.min(i++, values.length - 1)]!;
    if (v instanceof Error) throw v;
    return v;
  });
  return { redis: { get } as unknown as Redis, get };
}

const watches: { stop(): void }[] = [];
afterEach(() => watches.splice(0).forEach((w) => w.stop()));

function watch(redis: Redis | null, o: Parameters<typeof watchMaintenance>[1] = {}) {
  const w = watchMaintenance(redis, o);
  watches.push(w);
  return w;
}

describe('watchMaintenance', () => {
  it('нет Redis — обслуживания нет', async () => {
    expect(await watch(null).get()).toBeNull();
  });

  it('значение кэшируется на 1 с; одновременные вызовы делят один GET', async () => {
    let now = 0;
    const { redis, get } = fakeRedis([FLAG, null]);
    const w = watch(redis, { now: () => now });
    const [a, b] = await Promise.all([w.get(), w.get()]);
    expect(a).toEqual(JSON.parse(FLAG));
    expect(b).toEqual(a);
    expect(get).toHaveBeenCalledTimes(1);
    now = 999;
    expect(await w.get()).toEqual(a);
    expect(get).toHaveBeenCalledTimes(1);
    now = 1000;
    expect(await w.get()).toBeNull();
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('ошибка Redis — fail-open', async () => {
    const { redis } = fakeRedis([new Error('Connection is closed.')]);
    expect(await watch(redis).get()).toBeNull();
  });

  it('флаг с неверным JSON — всё равно обслуживание', async () => {
    const { redis } = fakeRedis(['не json']);
    expect(await watch(redis).get()).toEqual({ phase: '', startedAt: '', backup: '' });
  });

  it('onEnd вызывается при снятии флага, один раз', async () => {
    let now = 0;
    const onEnd = vi.fn();
    const { redis } = fakeRedis([FLAG, FLAG, null, null]);
    const w = watch(redis, { now: () => now, onEnd });
    for (let i = 0; i < 4; i++) {
      await w.get();
      now += 1000;
    }
    expect(onEnd).toHaveBeenCalledTimes(1);
  });
});
```

`apps/api/test/maintenance.int.test.ts`:

```ts
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createRedis } from '../src/lib/redis';
import { createAgentClient } from '../src/modules/backups/agent-client';
import { MAINTENANCE_KEY } from '../src/modules/maintenance/flag';
import { startFakeAgent, type FakeAgent } from './fake-agent';
import { createTestApp, loginAs, type TestApp } from './helpers';

const NAME = '2026-10-08T03-00-00Z';
const PRE = 'pre-restore-2026-10-08T10-00-00Z';
const FLAG = { phase: 'db', startedAt: '2026-10-08T10:00:05.000Z', backup: NAME };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Кэш флага в API — 1 с. */
const CACHE = 1_100;

const retry = (t: TestApp, ip: string, payload: object = { code: 'ABCD-EFGH-IJKL', target: 'same' }) =>
  t.app.inject({ method: 'POST', url: '/api/maintenance/retry', headers: { 'x-forwarded-for': ip }, payload });

describe('режим обслуживания', () => {
  let agent: FakeAgent;
  let t: TestApp;
  let cookie: string;

  beforeAll(async () => {
    agent = await startFakeAgent();
    agent.respond('GET', '/operation', {
      status: 200,
      body: { id: 'op1', status: 'failed', recovery: { backup: NAME, preRestore: PRE } },
    });
    agent.respond('POST', '/recovery', { status: 202, body: { operationId: 'op9' } });
    t = await createTestApp({ backupAgent: createAgentClient({ url: agent.url, token: agent.token }) });
    cookie = (await loginAs(t, 'admin')).cookie;
  });
  afterAll(async () => {
    await t.close();
    await agent.close();
  });

  it('без флага: /api/maintenance — { active: false }, запросы проходят', async () => {
    const m = await t.app.inject({ method: 'GET', url: '/api/maintenance' });
    expect(m.statusCode).toBe(200);
    expect(m.json()).toEqual({ active: false });
    expect((await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(200);
  });

  it('с флагом: 503 maintenance на всё, кроме белого списка; /api/maintenance с фазой и целями повтора', async () => {
    await t.deps.redis!.set(MAINTENANCE_KEY, JSON.stringify(FLAG));
    await sleep(CACHE);
    for (const [method, url] of [
      ['GET', '/api/auth/me'],
      ['POST', '/api/auth/login'],
      ['GET', '/api/templates'],
      ['GET', '/api/admin/backups'],
      ['GET', '/api/нет-такого'],
      ['GET', '/api/healthz'],
    ] as const) {
      const r = await t.app.inject({ method, url, headers: { cookie }, payload: method === 'POST' ? { login: 'a', password: 'b' } : undefined });
      expect(r.statusCode, `${method} ${url}`).toBe(503);
      expect(r.json()).toEqual({
        error: { code: 'maintenance', message: 'идёт восстановление из бэкапа, повторите позже', details: { phase: 'db' } },
      });
    }
    expect((await t.app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    const m = await t.app.inject({ method: 'GET', url: '/api/maintenance?t=1' });
    expect(m.statusCode).toBe(200);
    expect(m.json()).toEqual({ active: true, ...FLAG, recovery: { backup: NAME, preRestore: PRE } });
  });

  it('retry проксирует в /recovery; неверные данные — 400 без агента', async () => {
    const before = agent.requests.length;
    expect((await retry(t, '10.0.0.9', { code: 'X' })).statusCode).toBe(400);
    expect(agent.requests.length).toBe(before);
    const r = await retry(t, '10.0.0.9');
    expect(r.statusCode).toBe(202);
    expect(r.json()).toEqual({ operationId: 'op9' });
    expect(agent.requests.at(-1)).toMatchObject({
      method: 'POST',
      path: '/recovery',
      body: { code: 'ABCD-EFGH-IJKL', target: 'same' },
      auth: `Bearer ${agent.token}`,
    });
  });

  it('ответ агента 403 (неверный код) передаётся как есть', async () => {
    agent.respond('POST', '/recovery', { status: 403, body: { error: { code: 'BAD_CODE', message: 'неверный код восстановления' } } });
    const r = await retry(t, '10.0.0.8');
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toEqual({ code: 'BAD_CODE', message: 'неверный код восстановления' });
    agent.respond('POST', '/recovery', { status: 202, body: { operationId: 'op9' } });
  });

  it('лимит retry: 10 за 15 минут с одного IP, 11-й — 429; другой IP не задет', async () => {
    for (let i = 0; i < 10; i++) expect((await retry(t, '10.0.0.1')).statusCode).toBe(202);
    const r = await retry(t, '10.0.0.1');
    expect(r.statusCode).toBe(429);
    expect(r.json().error.code).toBe('TOO_MANY_ATTEMPTS');
    expect((await retry(t, '10.0.0.2')).statusCode).toBe(202);
  });

  it('после снятия флага запросы проходят, пулы источников сброшены', async () => {
    const closeAll = vi.spyOn(t.deps.sources, 'closeAll');
    await t.deps.redis!.del(MAINTENANCE_KEY);
    await sleep(CACHE);
    expect((await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'GET', url: '/api/maintenance' })).json()).toEqual({ active: false });
    expect(closeAll).toHaveBeenCalledTimes(1);
  });
});

describe('режим обслуживания без Redis и без агента', () => {
  it('Redis недоступен — fail-open: запросы проходят, лимит retry не применяется', async () => {
    const agent = await startFakeAgent();
    agent.respond('POST', '/recovery', { status: 409, body: { error: { code: 'NO_RECOVERY', message: 'восстановление по коду не требуется' } } });
    const deadRedis: Redis = createRedis('redis://127.0.0.1:1', { warn: () => {} });
    const t = await createTestApp({ redis: deadRedis, backupAgent: createAgentClient({ url: agent.url, token: agent.token }) });
    try {
      expect((await t.app.inject({ method: 'GET', url: '/api/maintenance' })).json()).toEqual({ active: false });
      const { cookie } = await loginAs(t, 'admin');
      expect((await t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(200);
      for (let i = 0; i < 12; i++) expect((await retry(t, '10.0.0.3')).statusCode).toBe(409);
    } finally {
      await t.close();
      deadRedis.disconnect();
      await agent.close();
    }
  });

  it('без агента: retry — 404 backups_disabled, recovery в статусе — null', async () => {
    const t = await createTestApp();
    try {
      await t.deps.redis!.set(MAINTENANCE_KEY, JSON.stringify(FLAG));
      const m = await t.app.inject({ method: 'GET', url: '/api/maintenance' });
      expect(m.json()).toEqual({ active: true, ...FLAG, recovery: null });
      const r = await retry(t, '10.0.0.4');
      expect(r.statusCode).toBe(404);
      expect(r.json().error.code).toBe('backups_disabled');
    } finally {
      await t.close();
    }
  });
});
```

- [ ] **Step 2: Запуск — должно упасть**

Run: `source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null && pnpm --filter @carbone-reports/api test; pnpm --filter @carbone-reports/api exec vitest run --config vitest.int.config.ts test/maintenance.int.test.ts`
Expected: FAIL — `Failed to resolve import "./flag"` / `"../src/modules/maintenance/flag"`.

- [ ] **Step 3: Реализация**

`apps/api/src/modules/maintenance/flag.ts`:

```ts
import type { Redis } from 'ioredis';

/** Флаг обслуживания; ставит и снимает только агент бэкапа (§26.2). */
export const MAINTENANCE_KEY = 'cr:maintenance';

export interface MaintenanceFlag {
  phase: string;
  startedAt: string;
  backup: string;
}

export interface MaintenanceWatch {
  get(): Promise<MaintenanceFlag | null>;
  stop(): void;
}

function parseFlag(raw: string): MaintenanceFlag {
  try {
    const v = JSON.parse(raw) as Partial<Record<keyof MaintenanceFlag, unknown>> | null;
    if (v && typeof v === 'object')
      return { phase: String(v.phase ?? ''), startedAt: String(v.startedAt ?? ''), backup: String(v.backup ?? '') };
  } catch {
    // ключ есть — обслуживание включено, даже если значение не разобрать
  }
  return { phase: '', startedAt: '', backup: '' };
}

/**
 * Флаг cr:maintenance с кэшем в процессе на ttlMs (§26.3). Ошибка Redis — «флага нет» (fail-open:
 * обслуживание включает только агент, и он всегда пишет флаг в Redis). Таймер раз в ttlMs обновляет
 * значение и без запросов, чтобы экземпляр заметил снятие флага (onEnd).
 */
export function watchMaintenance(
  redis: Redis | null,
  o: { ttlMs?: number; onEnd?: () => void; now?: () => number } = {},
): MaintenanceWatch {
  const ttl = o.ttlMs ?? 1000;
  const now = o.now ?? Date.now;
  let value: MaintenanceFlag | null = null;
  let at = -Infinity;
  let inflight: Promise<MaintenanceFlag | null> | null = null;

  async function refresh(): Promise<MaintenanceFlag | null> {
    let next: MaintenanceFlag | null = null;
    try {
      const raw = await redis!.get(MAINTENANCE_KEY);
      next = raw === null ? null : parseFlag(raw);
    } catch {
      next = null;
    }
    const ended = value !== null && next === null;
    value = next;
    at = now();
    if (ended) o.onEnd?.();
    return value;
  }

  function get(): Promise<MaintenanceFlag | null> {
    if (!redis) return Promise.resolve(null);
    if (now() - at < ttl) return Promise.resolve(value);
    inflight ??= refresh().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  const timer = redis ? setInterval(() => void get(), ttl) : null;
  timer?.unref();
  return {
    get,
    stop: () => {
      if (timer) clearInterval(timer);
    },
  };
}
```

`apps/api/src/modules/maintenance/routes.ts`:

```ts
import {
  RecoveryBody,
  type BackupPhase,
  type MaintenanceStatus,
  type RecoveryTargets,
} from '@carbone-reports/shared';
import type { Redis } from 'ioredis';
import type { App } from '../../app';
import type { AppDeps } from '../../deps';
import { AppError } from '../../lib/errors';
import { backupsDisabled } from '../backups/routes';
import { watchMaintenance } from './flag';

/** Доступны во время обслуживания (§26.3). */
const EXEMPT = new Set(['GET /api/health', 'GET /api/maintenance', 'POST /api/maintenance/retry']);

export const RETRY_LIMIT = 10;
export const RETRY_WINDOW_MS = 15 * 60_000;

/** Лимит повтора по коду: 10 за 15 минут с IP. Без Redis пропускается — остаётся лимит агента (5 попыток на код). */
async function retryAllowed(redis: Redis | null, ip: string): Promise<boolean> {
  if (!redis) return true;
  try {
    const key = `cr:rl-retry:${ip}`;
    const res = await redis.multi().incr(key).pexpire(key, RETRY_WINDOW_MS, 'NX').exec();
    return Number(res?.[0]?.[1] ?? 0) <= RETRY_LIMIT;
  } catch {
    return true;
  }
}

/** Регистрируется до остальных маршрутов: хук onRequest закрывает все, кроме белого списка. */
export function registerMaintenance(app: App, deps: AppDeps): void {
  const watch = watchMaintenance(deps.redis, {
    onEnd: () => {
      app.log.info('режим обслуживания снят: пулы источников данных будут открыты заново');
      deps.sources
        .closeAll()
        .catch((err: unknown) => app.log.warn({ err }, 'не удалось закрыть пулы источников данных'));
    },
  });
  app.addHook('onClose', async () => watch.stop());

  app.addHook('onRequest', async (req) => {
    if (EXEMPT.has(`${req.method} ${req.url.split('?')[0]}`)) return;
    const flag = await watch.get();
    if (flag)
      throw new AppError('maintenance', 503, 'идёт восстановление из бэкапа, повторите позже', {
        phase: flag.phase,
      });
  });

  app.get('/api/maintenance', async (): Promise<MaintenanceStatus> => {
    const flag = await watch.get();
    if (!flag) return { active: false };
    let recovery: RecoveryTargets | null = null;
    if (deps.backupAgent) {
      try {
        const r = await deps.backupAgent.request('GET', '/operation');
        const body = r.body as { recovery?: RecoveryTargets | null } | undefined;
        recovery = r.status === 200 ? (body?.recovery ?? null) : null;
      } catch {
        recovery = null;
      }
    }
    return {
      active: true,
      phase: flag.phase as BackupPhase,
      startedAt: flag.startedAt,
      backup: flag.backup,
      recovery,
    };
  });

  app.post('/api/maintenance/retry', { schema: { body: RecoveryBody } }, async (req, reply) => {
    if (!(await retryAllowed(deps.redis, req.ip)))
      throw new AppError('TOO_MANY_ATTEMPTS', 429, 'слишком много попыток ввода кода, повторите через 15 минут');
    if (!deps.backupAgent) throw backupsDisabled();
    const r = await deps.backupAgent.request('POST', '/recovery', req.body);
    // Код в журнал не пишется.
    req.log.warn({ status: r.status, target: req.body.target }, 'повтор восстановления по коду');
    return reply.status(r.status).send(r.body);
  });
}
```

`apps/api/src/app.ts` — импорт `import { registerMaintenance } from './modules/maintenance/routes';` и сразу после `registerErrorHandler(app);`:

```ts
  // До всех маршрутов: во время восстановления из бэкапа API отвечает 503 (§26.3).
  registerMaintenance(app, deps);
```

- [ ] **Step 4: Запуск — должно пройти**

```bash
cd /Users/sam/carbone-reports
source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null && pnpm --filter @carbone-reports/api test && pnpm --filter @carbone-reports/api exec vitest run --config vitest.int.config.ts test/maintenance.int.test.ts test/backups.int.test.ts test/auth.int.test.ts test/login-ip-limit.int.test.ts
```
Expected: PASS.

- [ ] **Step 5: Гейты и коммит**

```bash
cd /Users/sam/carbone-reports
source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null && pnpm exec prettier --write apps/api && pnpm typecheck && pnpm lint && pnpm exec prettier --check . && pnpm test && pnpm --filter @carbone-reports/api test:int
git add apps/api
git commit -m "feat(api): maintenance mode middleware with 1s cache and fail-open, public /api/maintenance and rate-limited recovery retry

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Task 7: Web: страница «Бэкапы», панель операции, диалог восстановления, пункт меню (§26.5)

**Files:**
- Create: `apps/web/src/lib/backups.ts`, `apps/web/src/lib/backups.test.ts`
- Modify: `apps/web/src/api/endpoints.ts` (импорты и разделы `backups`, `maintenance`)
- Modify: `apps/web/src/api/session.ts` (`SessionUser.features`)
- Create: `apps/web/src/pages/admin/BackupsPage.tsx`, `apps/web/src/pages/admin/RestoreDialog.tsx`, `apps/web/src/pages/admin/BackupsPage.test.tsx`
- Modify: `apps/web/src/app/routes.tsx`, `apps/web/src/app/Layout.tsx`, `apps/web/src/app/global.css`

**Interfaces:**
- Consumes: Task 5 — `GET/POST /api/admin/backups`, `POST /api/admin/backups/:name/restore`, `GET /api/admin/backups/operation` (200 | 204), `features.backups` в `/api/auth/me`; shared `BackupDto`, `BackupOperationDto`, `BackupPhase`, `MaintenanceStatus`, `RecoveryBody`, `Features`.
- Produces:
  - `api.backups.{ list(): Promise<BackupDto[]>; create(): Promise<{ operationId }>; restore(name): Promise<{ operationId }>; operation(): Promise<BackupOperationDto | null> }`;
  - `api.maintenance.{ status(): Promise<MaintenanceStatus>; retry(body: RecoveryBody): Promise<{ operationId }> }` (используется в Task 8);
  - `PHASE_LABEL`, `STATUS_LABEL`, `KIND_LABEL`, `formatSize(bytes | null)`, `requestedByLabel(by)` (`lib/backups.ts`);
  - `SessionUser.features?: Features`;
  - маршрут `/admin/backups`, пункт меню «Бэкапы» (иконка `Archive`) при `me.features?.backups`;
  - `data-testid="operation-status"` у статуса операции (его читает E2E).

Решения по интерфейсу:
- В колонке «Дата» под датой мелким шрифтом выводится имя каталога: его нужно ввести в диалоге, и по нему строку находит E2E.
- «Размер» — `база X · файлы Y`.
- «Миграция» — первые 12 символов хеша, полный хеш — в `title`.
- Пока операция `running`, кнопки «Сделать бэкап» и «Восстановить» неактивны. Когда операция закончилась, список бэкапов перечитывается.

- [ ] **Step 1: Падающие тесты**

`apps/web/src/lib/backups.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { formatSize, PHASE_LABEL, requestedByLabel } from './backups';

describe('backups', () => {
  it.each([
    [null, '—'],
    [0, '0 Б'],
    [1023, '1023 Б'],
    [1024, '1,0 КБ'],
    [1536, '1,5 КБ'],
    [5 * 1024 * 1024, '5,0 МБ'],
    [3 * 1024 ** 3, '3,0 ГБ'],
  ])('formatSize(%j) = %j', (bytes, text) => {
    expect(formatSize(bytes)).toBe(text);
  });
  it('подписи фаз и инициатора', () => {
    expect(PHASE_LABEL.db).toBe('Замена базы данных');
    expect(requestedByLabel('cron')).toBe('по расписанию');
    expect(requestedByLabel('recovery-code')).toBe('по коду восстановления');
    expect(requestedByLabel('admin')).toBe('admin');
  });
});
```

`apps/web/src/pages/admin/BackupsPage.test.tsx`:

```tsx
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { adminMe, mockApi, renderRoute } from '../../test/utils';

const me = { path: '/api/auth/me', body: { ...adminMe.body, features: { backups: true } } };
const NAME = '2026-10-08T03-00-00Z';
const PRE = 'pre-restore-2026-10-07T10-00-00Z';
const PARTIAL = '2026-10-06T03-00-00Z.partial';
const BACKUPS = [
  { name: NAME, createdAt: '2026-10-08T03:00:00Z', dbSize: 2 * 1024 * 1024, storageSize: 1536, lastMigration: 'abcdef0123456789'.repeat(4), kind: 'regular', status: 'ok' },
  { name: PRE, createdAt: '2026-10-07T10:00:00Z', dbSize: 10, storageSize: 20, lastMigration: null, kind: 'pre-restore', status: 'ok' },
  { name: PARTIAL, createdAt: '2026-10-06T03:00:00Z', dbSize: 5, storageSize: null, lastMigration: null, kind: 'regular', status: 'partial' },
];
const list = { path: '/api/admin/backups', body: BACKUPS };
const noOperation = { path: '/api/admin/backups/operation', status: 204 };
const op = (over: object = {}) => ({
  id: 'op1',
  type: 'backup',
  requestedBy: 'admin',
  backup: null,
  phase: 'backup',
  status: 'succeeded',
  startedAt: '2026-10-08T03:00:00Z',
  finishedAt: '2026-10-08T03:00:10Z',
  error: null,
  log: [`бэкап ${NAME}: готово`],
  recovery: null,
  ...over,
});
const row = (text: string) => screen.getByText(text).closest('tr')!;

describe('BackupsPage', () => {
  it('таблица: колонки, имя под датой, тип, размер, миграция, статус; «Восстановить» только у готовых', async () => {
    mockApi([me, list, noOperation]);
    renderRoute('/admin/backups');
    await screen.findByText(NAME);
    for (const h of ['Дата', 'Тип', 'Размер', 'Миграция', 'Статус'])
      expect(screen.getByRole('columnheader', { name: h })).toBeInTheDocument();
    expect(within(row(NAME)).getByText('база 2,0 МБ · файлы 1,5 КБ')).toBeInTheDocument();
    expect(within(row(NAME)).getByText('abcdef012345')).toBeInTheDocument();
    expect(within(row(PRE)).getByText('перед восстановлением')).toBeInTheDocument();
    expect(within(row(PARTIAL)).getByText('незавершён')).toBeInTheDocument();
    expect(within(row(PARTIAL)).queryByRole('button', { name: 'Восстановить' })).not.toBeInTheDocument();
    expect(within(row(NAME)).getByRole('button', { name: 'Восстановить' })).toBeEnabled();
    expect(within(row(PRE)).getByRole('button', { name: 'Восстановить' })).toBeEnabled();
  });

  it('«Сделать бэкап»: POST, панель опрашивает операцию раз в 2 с, пока она идёт; затем список перечитывается', async () => {
    let created = false;
    let polls = 0;
    let listCalls = 0;
    mockApi([
      me,
      { path: '/api/admin/backups', handler: () => (listCalls++, { body: BACKUPS }) },
      { method: 'POST', path: '/api/admin/backups', handler: () => ((created = true), { status: 202, body: { operationId: 'op2' } }) },
      {
        path: '/api/admin/backups/operation',
        handler: () => {
          if (!created) return { status: 204 };
          polls++;
          return { body: op({ id: 'op2', status: polls === 1 ? 'running' : 'succeeded' }) };
        },
      },
    ]);
    renderRoute('/admin/backups');
    await screen.findByText(NAME);
    await userEvent.click(screen.getByRole('button', { name: 'Сделать бэкап' }));
    expect(await screen.findByText('выполняется')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Сделать бэкап' })).toBeDisabled();
    expect(within(row(NAME)).getByRole('button', { name: 'Восстановить' })).toBeDisabled();
    expect(await screen.findByText('успешно', undefined, { timeout: 4_000 })).toBeInTheDocument();
    await waitFor(() => expect(listCalls).toBeGreaterThanOrEqual(2));
  }, 10_000);

  it('агент занят (409) — текст ошибки в уведомлении', async () => {
    mockApi([
      me,
      list,
      noOperation,
      {
        method: 'POST',
        path: '/api/admin/backups',
        status: 409,
        body: {
          error: { code: 'BUSY', message: 'уже выполняется другая операция с бэкапами' },
          busy: { type: 'restore', startedAt: '2026-10-08T10:00:00Z' },
        },
      },
    ]);
    renderRoute('/admin/backups');
    await screen.findByText(NAME);
    await userEvent.click(screen.getByRole('button', { name: 'Сделать бэкап' }));
    expect(await screen.findByText('уже выполняется другая операция с бэкапами')).toBeInTheDocument();
  });

  it('панель последней операции: тип, кто запустил, этап, статус, ошибка, журнал в свёрнутом блоке', async () => {
    mockApi([
      me,
      list,
      {
        path: '/api/admin/backups/operation',
        body: op({
          type: 'restore',
          backup: NAME,
          requestedBy: 'cron',
          phase: 'verify',
          status: 'failed',
          error: 'бэкап создан более новой версией приложения',
          log: ['этап: verify'],
        }),
      },
    ]);
    renderRoute('/admin/backups');
    expect(await screen.findByText(`Восстановление из ${NAME}`)).toBeInTheDocument();
    expect(screen.getByText(/Запустил: по расписанию/)).toBeInTheDocument();
    expect(screen.getByText('Этап: Проверка бэкапа')).toBeInTheDocument();
    expect(screen.getByTestId('operation-status')).toHaveTextContent('ошибка');
    expect(screen.getByText('бэкап создан более новой версией приложения')).toBeInTheDocument();
    const details = screen.getByText('Журнал').closest('details')!;
    expect(details).not.toHaveAttribute('open');
    expect(within(details).getByText('этап: verify')).toBeInTheDocument();
  });

  it('диалог: предупреждение; кнопка активна только при точном имени; POST restore', async () => {
    const { calls } = mockApi([
      me,
      list,
      noOperation,
      { method: 'POST', path: '/api/admin/backups/:name/restore', status: 202, body: { operationId: 'op3' } },
    ]);
    renderRoute('/admin/backups');
    await screen.findByText(NAME);
    await userEvent.click(within(row(NAME)).getByRole('button', { name: 'Восстановить' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/будут заменены/)).toBeInTheDocument();
    expect(within(dialog).getByText(/будет сделан бэкап текущего состояния/)).toBeInTheDocument();
    expect(within(dialog).getByText(/может разлогинить/)).toBeInTheDocument();
    const apply = within(dialog).getByRole('button', { name: 'Восстановить' });
    const input = within(dialog).getByLabelText('Введите имя бэкапа для подтверждения');
    expect(apply).toBeDisabled();
    for (const wrong of [` ${NAME}`, NAME.toLowerCase(), NAME.slice(0, -1)]) {
      await userEvent.clear(input);
      await userEvent.type(input, wrong);
      expect(apply).toBeDisabled();
    }
    await userEvent.clear(input);
    await userEvent.type(input, NAME);
    expect(apply).toBeEnabled();
    await userEvent.click(apply);
    await waitFor(() =>
      expect(calls).toContainEqual({ method: 'POST', path: `/api/admin/backups/${NAME}/restore`, body: undefined }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('пункт меню «Бэкапы» — только если функция включена', async () => {
    mockApi([me, { path: '/api/templates', body: [] }]);
    const first = renderRoute('/reports');
    expect(await screen.findByText('Бэкапы')).toBeInTheDocument();
    first.unmount();
    mockApi([adminMe, { path: '/api/templates', body: [] }]);
    renderRoute('/reports');
    expect(await screen.findByText('Пользователи')).toBeInTheDocument();
    expect(screen.queryByText('Бэкапы')).not.toBeInTheDocument();
  });
});
```

В последнем тесте второй `mockApi` заменяет первый: `vi.spyOn` на уже подменённом `fetch` ставит новую реализацию, а `restoreAllMocks` в `afterEach` (`test/setup.tsx`) снимает обе.

- [ ] **Step 2: Запуск — должно упасть**

Run: `source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null && pnpm --filter @carbone-reports/web test -- src/lib/backups.test.ts src/pages/admin/BackupsPage.test.tsx`
Expected: FAIL — `Failed to resolve import "./backups"`; маршрута `/admin/backups` нет.

- [ ] **Step 3: API-клиент и подписи**

`apps/web/src/lib/backups.ts`:

```ts
import type { BackupDto, BackupOperationDto, BackupPhase } from '@carbone-reports/shared';

export const PHASE_LABEL: Record<BackupPhase, string> = {
  backup: 'Создание бэкапа',
  verify: 'Проверка бэкапа',
  'pre-backup': 'Бэкап перед восстановлением',
  maintenance: 'Включение режима обслуживания',
  db: 'Замена базы данных',
  migrate: 'Применение миграций',
  storage: 'Восстановление файлов',
  redis: 'Очистка кэша',
  done: 'Готово',
};

export const STATUS_LABEL: Record<BackupOperationDto['status'], string> = {
  running: 'выполняется',
  succeeded: 'успешно',
  failed: 'ошибка',
};

export const KIND_LABEL: Record<BackupDto['kind'], string> = {
  regular: 'обычный',
  'pre-restore': 'перед восстановлением',
};

export function formatSize(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${bytes} Б`;
  const units = ['КБ', 'МБ', 'ГБ', 'ТБ'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1).replace('.', ',')} ${units[i]}`;
}

export function requestedByLabel(by: string): string {
  if (by === 'cron') return 'по расписанию';
  if (by === 'recovery-code') return 'по коду восстановления';
  return by;
}
```

`apps/web/src/api/endpoints.ts`:
- в импорт из `@carbone-reports/shared` добавить `BackupDto`, `BackupOperationDto`, `MaintenanceStatus`, `RecoveryBody`;
- в объект `api` после раздела `users` (или в конец объекта):

  ```ts
    backups: {
      list: () => apiJson<BackupDto[]>('/api/admin/backups'),
      create: () => apiJson<{ operationId: string }>('/api/admin/backups', post()),
      restore: (name: string) =>
        apiJson<{ operationId: string }>(`/api/admin/backups/${encodeURIComponent(name)}/restore`, post()),
      /** null — операций ещё не было (204): данные запроса TanStack Query не могут быть undefined. */
      operation: async () =>
        (await apiJson<BackupOperationDto | undefined>('/api/admin/backups/operation')) ?? null,
    },

    maintenance: {
      status: () => apiJson<MaintenanceStatus>('/api/maintenance'),
      retry: (body: RecoveryBody) =>
        apiJson<{ operationId: string }>('/api/maintenance/retry', post(body)),
    },
  ```

`apps/web/src/api/session.ts`:
- импорт `import type { Features, Role } from '@carbone-reports/shared';` (вместо `import type { Role } …`);
- в `SessionUser` добавить:

  ```ts
    /** Включённые функции (§26.3); нет поля — функции выключены. */
    features?: Features;
  ```

- [ ] **Step 4: Страница, диалог, маршрут, меню**

`apps/web/src/pages/admin/RestoreDialog.tsx`:

```tsx
import type { BackupDto } from '@carbone-reports/shared';
import { Alert, Dialog, TextInput } from '@gravity-ui/uikit';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../../api/endpoints';
import { ErrorAlert } from '../../components/ErrorAlert';
import { Field } from '../../components/Field';

const CONFIRM_LABEL = 'Введите имя бэкапа для подтверждения';

/** Подтверждение восстановления точным именем бэкапа (§26.5). */
export function RestoreDialog({
  backup,
  onClose,
  onStarted,
}: {
  backup: BackupDto | null;
  onClose: () => void;
  onStarted: () => void;
}) {
  const [typed, setTyped] = useState('');
  const name = backup?.name ?? '';
  const restore = useMutation({
    mutationFn: (n: string) => api.backups.restore(n),
    onSuccess: () => {
      onStarted();
      close();
    },
  });

  function close() {
    setTyped('');
    restore.reset();
    onClose();
  }

  return (
    <Dialog open={backup !== null} onClose={close} aria-labelledby="cr-restore-title" size="m">
      <Dialog.Header caption="Восстановление из бэкапа" id="cr-restore-title" />
      <Dialog.Body>
        <div className="cr-form">
          <Alert
            theme="warning"
            title="База данных и файлы будут заменены"
            message={
              <>
                Данные приложения будут заменены состоянием из бэкапа <b>{name}</b>. Перед
                восстановлением будет сделан бэкап текущего состояния (pre-restore-…) — к нему можно
                вернуться. Пользователей, в том числе вас, может разлогинить: понадобится войти заново.
              </>
            }
          />
          <Field label={CONFIRM_LABEL} hint={name}>
            <TextInput
              value={typed}
              onUpdate={setTyped}
              placeholder={name}
              autoComplete="off"
              controlProps={{ 'aria-label': CONFIRM_LABEL }}
            />
          </Field>
          <ErrorAlert error={restore.error} />
        </div>
      </Dialog.Body>
      <Dialog.Footer
        onClickButtonApply={() => restore.mutate(name)}
        onClickButtonCancel={close}
        textButtonApply="Восстановить"
        textButtonCancel="Отмена"
        loading={restore.isPending}
        propsButtonApply={{ view: 'outlined-danger', disabled: name === '' || typed !== name }}
      />
    </Dialog>
  );
}
```

`apps/web/src/pages/admin/BackupsPage.tsx`:

```tsx
import type { BackupDto, BackupOperationDto } from '@carbone-reports/shared';
import type { TableColumnConfig } from '@gravity-ui/uikit';
import { Alert, Button, Label, Loader, Table, Text, useToaster } from '@gravity-ui/uikit';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../api/endpoints';
import { errorMessage } from '../../api/errors';
import { ErrorAlert } from '../../components/ErrorAlert';
import { PageHeader } from '../../components/PageHeader';
import { formatSize, KIND_LABEL, PHASE_LABEL, requestedByLabel, STATUS_LABEL } from '../../lib/backups';
import { formatDateTime } from '../../lib/format';
import { RestoreDialog } from './RestoreDialog';

const backupsKey = ['backups'] as const;
const operationKey = ['backups', 'operation'] as const;
const STATUS_THEME = { running: 'info', succeeded: 'success', failed: 'danger' } as const;

function OperationPanel({ op }: { op: BackupOperationDto }) {
  return (
    <div className="cr-backup-operation">
      <Text variant="subheader-2" as="div">
        {op.type === 'backup' ? 'Бэкап' : `Восстановление из ${op.backup ?? '—'}`}
      </Text>
      <Text as="div" color="secondary">
        Запустил: {requestedByLabel(op.requestedBy)} · {formatDateTime(op.startedAt)}
      </Text>
      <Text as="div">Этап: {PHASE_LABEL[op.phase]}</Text>
      <span data-testid="operation-status">
        <Label theme={STATUS_THEME[op.status]}>{STATUS_LABEL[op.status]}</Label>
      </span>
      {op.error && <Alert theme="danger" message={op.error} />}
      <details>
        <summary>Журнал</summary>
        <pre className="cr-backup-log">{op.log.join('\n')}</pre>
      </details>
    </div>
  );
}

export function BackupsPage() {
  const queryClient = useQueryClient();
  const { add } = useToaster();
  const backups = useQuery({ queryKey: backupsKey, queryFn: api.backups.list });
  const operation = useQuery({
    queryKey: operationKey,
    queryFn: api.backups.operation,
    // §26.5: пока операция идёт, панель опрашивается раз в 2 с.
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 2000 : false),
  });
  const running = operation.data?.status === 'running';
  const wasRunning = useRef(false);
  useEffect(() => {
    // Операция закончилась — в списке появился новый бэкап (или pre-restore).
    if (wasRunning.current && !running)
      void queryClient.invalidateQueries({ queryKey: backupsKey, exact: true });
    wasRunning.current = running;
  }, [running, queryClient]);
  const [restoring, setRestoring] = useState<BackupDto | null>(null);

  const fail = (e: unknown) =>
    add({ name: `backups-error-${Date.now()}`, title: 'Ошибка', content: errorMessage(e), theme: 'danger' });
  const refreshOperation = () => queryClient.invalidateQueries({ queryKey: operationKey });
  const create = useMutation({ mutationFn: api.backups.create, onSuccess: refreshOperation, onError: fail });

  const columns: TableColumnConfig<BackupDto>[] = [
    {
      id: 'date',
      name: 'Дата',
      template: (b) => (
        <div>
          <div>{formatDateTime(b.createdAt)}</div>
          <Text color="secondary" variant="caption-2">
            {b.name}
          </Text>
        </div>
      ),
    },
    {
      id: 'kind',
      name: 'Тип',
      template: (b) =>
        b.kind === 'pre-restore' ? <Label theme="info">{KIND_LABEL[b.kind]}</Label> : KIND_LABEL[b.kind],
    },
    {
      id: 'size',
      name: 'Размер',
      template: (b) => `база ${formatSize(b.dbSize)} · файлы ${formatSize(b.storageSize)}`,
    },
    {
      id: 'migration',
      name: 'Миграция',
      template: (b) => (b.lastMigration ? <span title={b.lastMigration}>{b.lastMigration.slice(0, 12)}</span> : '—'),
    },
    {
      id: 'status',
      name: 'Статус',
      template: (b) =>
        b.status === 'ok' ? <Label theme="success">готов</Label> : <Label theme="warning">незавершён</Label>,
    },
    {
      id: 'actions',
      name: '',
      align: 'end',
      template: (b) =>
        b.status === 'ok' ? (
          <Button view="outlined-danger" size="s" disabled={running} onClick={() => setRestoring(b)}>
            Восстановить
          </Button>
        ) : null,
    },
  ];

  return (
    <>
      <PageHeader
        title="Бэкапы"
        actions={
          <Button view="action" loading={create.isPending} disabled={running} onClick={() => create.mutate()}>
            Сделать бэкап
          </Button>
        }
      />
      <ErrorAlert error={operation.error} title="Не удалось получить состояние операции" />
      {operation.data && <OperationPanel op={operation.data} />}
      <ErrorAlert error={backups.error} title="Не удалось получить список бэкапов" />
      {backups.isPending ? (
        <Loader />
      ) : (
        backups.data && <Table data={backups.data} columns={columns} emptyMessage="Бэкапов пока нет" width="max" />
      )}
      <RestoreDialog backup={restoring} onClose={() => setRestoring(null)} onStarted={() => void refreshOperation()} />
    </>
  );
}
```

`apps/web/src/app/routes.tsx` — импорт `import { BackupsPage } from '../pages/admin/BackupsPage';` и в детях `admin` после `{ path: 'categories', element: <CategoriesPage /> },`:

```tsx
              { path: 'backups', element: <BackupsPage /> },
```

`apps/web/src/app/Layout.tsx`:
- в импорт из `@gravity-ui/icons` добавить `Archive`;
- блок `menuItems.push(…)` для админа заменить на:

  ```tsx
    menuItems.push(
      { id: 'admin-divider', title: '', type: 'divider' },
      item('templates', 'Шаблоны', Layers, '/admin/templates'),
      item('datasources', 'Источники данных', Database, '/admin/datasources'),
      item('users', 'Пользователи', Persons, '/admin/users'),
      item('groups', 'Группы', PersonsLock, '/admin/groups'),
      item('categories', 'Категории', Folders, '/admin/categories'),
      // §26.3: пункт есть, только если API настроен на агент бэкапа.
      ...(me.features?.backups ? [item('backups', 'Бэкапы', Archive, '/admin/backups')] : []),
      item('help', 'Справка по шаблонам', CircleQuestion, '/admin/help'),
    );
  ```

`apps/web/src/app/global.css` — в конец:

```css
.cr-backup-operation {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 8px;
  margin-bottom: 20px;
  padding: 16px;
  border: 1px solid var(--g-color-line-generic);
  border-radius: 8px;
}

.cr-backup-log {
  max-height: 320px;
  overflow: auto;
  margin: 8px 0 0;
  font-size: 12px;
  white-space: pre-wrap;
}
```

- [ ] **Step 5: Запуск — должно пройти**

Run: `source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null && pnpm --filter @carbone-reports/web test`
Expected: PASS — новые тесты и прежние (в том числе `auth.test.tsx`: без `features` пункта «Бэкапы» нет, остальное меню прежнее).

- [ ] **Step 6: Гейты и коммит**

```bash
cd /Users/sam/carbone-reports
source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null && pnpm exec prettier --write apps/web/src && pnpm typecheck && pnpm lint && pnpm exec prettier --check . && pnpm test
git add apps/web/src
git commit -m "feat(web): Backups admin page with operation panel, restore confirmation by exact name and menu item behind features.backups

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Task 8: Web: экран обслуживания и форма кода восстановления (§26.4, §26.5)

**Files:**
- Create: `apps/web/src/api/maintenance.ts`
- Modify: `apps/web/src/api/client.ts` (функция `send`), `apps/web/src/api/client.test.ts`
- Create: `apps/web/src/components/MaintenanceScreen.tsx`, `apps/web/src/components/MaintenanceScreen.test.tsx`
- Create: `apps/web/src/app/MaintenanceGate.tsx`
- Modify: `apps/web/src/app/App.tsx`, `apps/web/src/app/global.css`

**Interfaces:**
- Consumes: Task 6 — 503 `{ error: { code: 'maintenance', … } }`, `GET /api/maintenance` → `MaintenanceStatus`, `POST /api/maintenance/retry {code, target}`. Task 7 — `api.maintenance.status`, `api.maintenance.retry`, `PHASE_LABEL`.
- Produces:
  - `reportMaintenance()`, `isMaintenanceReported()`, `onMaintenance(listener): () => void`, `resetMaintenance()` (тесты);
  - `MaintenanceGate({ children })`, `MaintenanceScreen({ reload? })`, `MAINTENANCE_POLL_MS = 3000`.

Как это работает:
- Любой ответ API 503 с кодом `maintenance` (из `send` в `api/client.ts`, то есть из любого запроса приложения) вызывает `reportMaintenance()`.
- `MaintenanceGate` стоит над `RouterProvider` и через `useSyncExternalStore` заменяет всё приложение экраном обслуживания.
- Экран опрашивает `/api/maintenance` раз в 3 с:
  - `active: false` → `window.location.reload()` (§26.5); после перезагрузки сессия проверяется заново, и при необходимости открывается вход;
  - `recovery` не `null` → форма кода.

  Пока идёт повтор, агент отдаёт `recovery: null`, и форма скрывается сама.

- [ ] **Step 1: Падающие тесты**

`apps/web/src/api/client.test.ts` — в импорты добавить `import { isMaintenanceReported, resetMaintenance } from './maintenance';`, в конец файла:

```ts
describe('режим обслуживания', () => {
  it('503 с кодом maintenance включает экран обслуживания; другие ошибки — нет', async () => {
    mockApi([
      { path: '/api/a', status: 503, body: { error: { code: 'INTERNAL', message: 'x' } } },
      { path: '/api/b', status: 503, body: { error: { code: 'maintenance', message: 'идёт восстановление из бэкапа, повторите позже' } } },
    ]);
    try {
      await apiJson('/api/a').catch(() => {});
      expect(isMaintenanceReported()).toBe(false);
      const err = await apiJson('/api/b').catch((e: unknown) => e);
      expect(err).toMatchObject({ status: 503, code: 'maintenance' });
      expect(isMaintenanceReported()).toBe(true);
    } finally {
      resetMaintenance();
    }
  });
});
```

`apps/web/src/components/MaintenanceScreen.test.tsx`:

```tsx
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiJson } from '../api/client';
import { resetMaintenance } from '../api/maintenance';
import { MaintenanceGate } from '../app/MaintenanceGate';
import { mockApi, renderWithProviders } from '../test/utils';
import { MaintenanceScreen } from './MaintenanceScreen';

const NAME = '2026-10-08T03-00-00Z';
const PRE = 'pre-restore-2026-10-08T10-00-00Z';
const active = (recovery: object | null = null) => ({
  active: true,
  phase: 'db',
  startedAt: '2026-10-08T10:00:05.000Z',
  backup: NAME,
  recovery,
});
const MAINTENANCE_503 = {
  status: 503,
  body: { error: { code: 'maintenance', message: 'идёт восстановление из бэкапа, повторите позже', details: { phase: 'db' } } },
};

afterEach(() => resetMaintenance());

describe('MaintenanceGate', () => {
  it('ответ 503 maintenance на любой запрос — экран на всю страницу вместо приложения', async () => {
    mockApi([{ path: '/api/x', ...MAINTENANCE_503 }, { path: '/api/maintenance', body: active() }]);
    renderWithProviders(
      <MaintenanceGate>
        <div>приложение</div>
      </MaintenanceGate>,
    );
    expect(screen.getByText('приложение')).toBeInTheDocument();
    await apiJson('/api/x').catch(() => {});
    expect(await screen.findByText('Идёт восстановление из бэкапа…')).toBeInTheDocument();
    expect(screen.queryByText('приложение')).not.toBeInTheDocument();
    expect(await screen.findByText(`Этап: Замена базы данных · бэкап ${NAME}`)).toBeInTheDocument();
  });

  it('другие 503 экран не включают', async () => {
    mockApi([{ path: '/api/x', status: 503, body: { error: { code: 'INTERNAL', message: 'x' } } }]);
    renderWithProviders(
      <MaintenanceGate>
        <div>приложение</div>
      </MaintenanceGate>,
    );
    await apiJson('/api/x').catch(() => {});
    expect(screen.getByText('приложение')).toBeInTheDocument();
  });
});

describe('MaintenanceScreen', () => {
  it('опрашивает /api/maintenance раз в 3 с и перезагружает страницу, когда обслуживание закончилось', async () => {
    let n = 0;
    const reload = vi.fn();
    mockApi([{ path: '/api/maintenance', handler: () => ({ body: ++n === 1 ? active() : { active: false } }) }]);
    renderWithProviders(<MaintenanceScreen reload={reload} />);
    expect(await screen.findByText(/Этап: Замена базы данных/)).toBeInTheDocument();
    expect(reload).not.toHaveBeenCalled();
    await waitFor(() => expect(reload).toHaveBeenCalledTimes(1), { timeout: 4_500 });
    expect(n).toBe(2);
  }, 8_000);

  it('«требуется восстановление»: форма кода, две кнопки; повтор отправляет код и цель', async () => {
    const { calls } = mockApi([
      { path: '/api/maintenance', body: active({ backup: NAME, preRestore: PRE }) },
      { method: 'POST', path: '/api/maintenance/retry', status: 202, body: { operationId: 'op9' } },
    ]);
    renderWithProviders(<MaintenanceScreen reload={vi.fn()} />);
    expect(await screen.findByText('Восстановление не завершено: база частично заменена')).toBeInTheDocument();
    const same = screen.getByRole('button', { name: `Повторить восстановление из ${NAME}` });
    const back = screen.getByRole('button', { name: `Вернуть состояние до восстановления (${PRE})` });
    expect(same).toBeDisabled();
    expect(back).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Код восстановления'), 'abcd-efgh-ijkl');
    expect(same).toBeEnabled();
    await userEvent.click(back);
    await waitFor(() =>
      expect(calls).toContainEqual({
        method: 'POST',
        path: '/api/maintenance/retry',
        body: { code: 'abcd-efgh-ijkl', target: 'pre-restore' },
      }),
    );
    expect(await screen.findByText('Повтор запущен, ждём завершения…')).toBeInTheDocument();
  });

  it('неверный код и лимит — текст ошибки сервера', async () => {
    mockApi([
      { path: '/api/maintenance', body: active({ backup: NAME, preRestore: null }) },
      { method: 'POST', path: '/api/maintenance/retry', status: 403, body: { error: { code: 'BAD_CODE', message: 'неверный код восстановления' } } },
    ]);
    renderWithProviders(<MaintenanceScreen reload={vi.fn()} />);
    await userEvent.type(await screen.findByLabelText('Код восстановления'), 'AAAA-AAAA-AAAA');
    expect(screen.queryByRole('button', { name: /Вернуть состояние до восстановления/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: `Повторить восстановление из ${NAME}` }));
    expect(await screen.findByText('неверный код восстановления')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Запуск — должно упасть**

Run: `source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null && pnpm --filter @carbone-reports/web test -- src/api/client.test.ts src/components/MaintenanceScreen.test.tsx`
Expected: FAIL — `Failed to resolve import "./maintenance"`, `"../app/MaintenanceGate"`, `"./MaintenanceScreen"`.

- [ ] **Step 3: Реализация**

`apps/web/src/api/maintenance.ts`:

```ts
type Listener = () => void;

const listeners = new Set<Listener>();
let reported = false;

/** Ответ 503 с кодом maintenance (§26.5): приложение переключается на экран обслуживания. */
export function reportMaintenance(): void {
  if (reported) return;
  reported = true;
  for (const l of listeners) l();
}

export const isMaintenanceReported = () => reported;

export function onMaintenance(listener: Listener): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** Только для тестов: экран обслуживания снимается перезагрузкой страницы. */
export function resetMaintenance(): void {
  reported = false;
}
```

`apps/web/src/api/client.ts`:
- импорт `import { reportMaintenance } from './maintenance';`;
- в `send` строку `if (!res.ok) throw await toError(res);` заменить на:

  ```ts
    if (!res.ok) {
      const err = await toError(res);
      // Идёт восстановление из бэкапа: экран обслуживания вместо приложения (MaintenanceGate).
      if (err.status === 503 && err.code === 'maintenance') reportMaintenance();
      throw err;
    }
  ```

`apps/web/src/components/MaintenanceScreen.tsx`:

```tsx
import type { RecoveryTargets } from '@carbone-reports/shared';
import { Alert, Button, Loader, Text, TextInput } from '@gravity-ui/uikit';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '../api/endpoints';
import { PHASE_LABEL } from '../lib/backups';
import { ErrorAlert } from './ErrorAlert';
import { Field } from './Field';

/** §26.5: экран опрашивает /api/maintenance раз в 3 с. */
export const MAINTENANCE_POLL_MS = 3000;

const reloadPage = () => window.location.reload();

function RecoveryForm({ recovery }: { recovery: RecoveryTargets }) {
  const [code, setCode] = useState('');
  const retry = useMutation({
    mutationFn: (target: 'same' | 'pre-restore') => api.maintenance.retry({ code, target }),
  });
  const disabled = !code.trim() || retry.isPending;
  return (
    <div className="cr-form">
      <Alert
        theme="danger"
        title="Восстановление не завершено: база частично заменена"
        message="Введите код восстановления из журнала сервиса backup (docker compose logs backup) и выберите действие."
      />
      <Field label="Код восстановления">
        <TextInput
          value={code}
          onUpdate={setCode}
          placeholder="XXXX-XXXX-XXXX"
          autoComplete="off"
          controlProps={{ 'aria-label': 'Код восстановления' }}
        />
      </Field>
      <ErrorAlert error={retry.error} />
      {retry.isSuccess && <Text color="secondary">Повтор запущен, ждём завершения…</Text>}
      <Button
        view="action"
        disabled={disabled}
        loading={retry.isPending && retry.variables === 'same'}
        onClick={() => retry.mutate('same')}
      >
        Повторить восстановление из {recovery.backup}
      </Button>
      {recovery.preRestore && (
        <Button
          view="outlined-danger"
          disabled={disabled}
          loading={retry.isPending && retry.variables === 'pre-restore'}
          onClick={() => retry.mutate('pre-restore')}
        >
          Вернуть состояние до восстановления ({recovery.preRestore})
        </Button>
      )}
    </div>
  );
}

/** Экран на всю страницу, пока идёт восстановление из бэкапа (§26.5). */
export function MaintenanceScreen({ reload = reloadPage }: { reload?: () => void }) {
  const status = useQuery({
    queryKey: ['maintenance'],
    queryFn: api.maintenance.status,
    refetchInterval: MAINTENANCE_POLL_MS,
  });
  const data = status.data;
  useEffect(() => {
    if (data && !data.active) reload();
  }, [data, reload]);
  const recovery = data?.active ? data.recovery : null;
  return (
    <div className="cr-centered">
      <div className="cr-maintenance">
        {!recovery && <Loader size="m" />}
        <Text variant="header-1" as="h1">
          Идёт восстановление из бэкапа…
        </Text>
        {data?.active && (
          <Text as="div" color="secondary">
            Этап: {PHASE_LABEL[data.phase] ?? data.phase} · бэкап {data.backup}
          </Text>
        )}
        {recovery && <RecoveryForm recovery={recovery} />}
      </div>
    </div>
  );
}
```

`apps/web/src/app/MaintenanceGate.tsx`:

```tsx
import { useSyncExternalStore, type ReactNode } from 'react';
import { isMaintenanceReported, onMaintenance } from '../api/maintenance';
import { MaintenanceScreen } from '../components/MaintenanceScreen';

/** Над роутером: после первого ответа 503 maintenance всё приложение заменяет экран обслуживания. */
export function MaintenanceGate({ children }: { children: ReactNode }) {
  const active = useSyncExternalStore(onMaintenance, isMaintenanceReported);
  return active ? <MaintenanceScreen /> : <>{children}</>;
}
```

`apps/web/src/app/App.tsx` — импорт `import { MaintenanceGate } from './MaintenanceGate';` и внутри `QueryClientProvider`:

```tsx
          <QueryClientProvider client={queryClient}>
            <MaintenanceGate>
              <RouterProvider router={router} />
            </MaintenanceGate>
          </QueryClientProvider>
```

`apps/web/src/app/global.css` — в конец:

```css
.cr-maintenance {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  max-width: 560px;
  padding: 24px;
  text-align: center;
}

.cr-maintenance .cr-form {
  align-items: stretch;
  width: 100%;
  text-align: left;
}
```

- [ ] **Step 4: Запуск — должно пройти**

Run: `source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null && pnpm --filter @carbone-reports/web test`
Expected: PASS.

- [ ] **Step 5: Гейты и коммит**

```bash
cd /Users/sam/carbone-reports
source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null && pnpm exec prettier --write apps/web/src && pnpm typecheck && pnpm lint && pnpm exec prettier --check . && pnpm test && pnpm --filter @carbone-reports/web build
git add apps/web/src
git commit -m "feat(web): full-page maintenance screen on 503 maintenance with polling, reload and recovery code form

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

## Task 9: E2E, README, заметки и живой прогон в compose (§26.6, §26.7)

**Files:**
- Create: `e2e/tests/backups.spec.ts`
- Modify: `README.md` (разделы «Файлы в S3-хранилище», «Redis», «Запуск из готовых образов», «Обновление / выкат», «Резервное копирование», новый «Бэкапы в админке», «Конфигурация», «Формат ошибок»)
- Modify: `docs/superpowers/notes/2026-10-02-backend-follow-ups.md` (в конец)

**Interfaces:**
- Consumes: всё из Task 1–8. Из E2E-фикстур: `adminApi()`, `loginAdminUi(page)`, `loginUi(page, login, password)`, `ADMIN`, `test`, `expect` (`e2e/fixtures.ts`). В интерфейсе: `data-testid="operation-status"`, кнопки «Сделать бэкап» и «Восстановить», поле «Введите имя бэкапа для подтверждения», заголовок «Идёт восстановление из бэкапа…».
- Produces: E2E-сценарий §26.7, документация, итоги плана.

- [ ] **Step 1: E2E-сценарий**

`e2e/tests/backups.spec.ts`:

```ts
import { ADMIN, adminApi, expect, loginAdminUi, loginUi, test } from '../fixtures';

interface Backup {
  name: string;
  kind: string;
  status: string;
}
interface Operation {
  type: string;
  status: string;
  backup: string | null;
  requestedBy: string;
}

test('бэкап из админки → изменение данных → восстановление → повторный вход: данные из бэкапа', async ({
  page,
  browser,
}) => {
  test.setTimeout(600_000);
  const api = await adminApi();
  const me = await api.get<{ features?: { backups: boolean } }>('/api/auth/me');
  expect(me.features?.backups, 'управление бэкапами выключено: у api нет BACKUP_AGENT_URL').toBe(true);

  const suffix = Date.now().toString(36);
  const kept = `e2e-бэкап-${suffix}`;
  const later = `e2e-после-${suffix}`;
  const keptId = (await api.post<{ id: string }>('/api/categories', { name: kept })).id;
  const before = new Set((await api.get<Backup[]>('/api/admin/backups')).map((b) => b.name));

  // Бэкап из админки.
  await loginAdminUi(page);
  await page.goto('/admin/backups');
  await page.getByRole('button', { name: 'Сделать бэкап' }).click();
  await expect(page.getByTestId('operation-status')).toHaveText('успешно', { timeout: 300_000 });
  const created = (await api.get<Backup[]>('/api/admin/backups')).find(
    (b) => !before.has(b.name) && b.kind === 'regular',
  );
  expect(created?.status).toBe('ok');
  const name = created!.name;

  // Изменение данных после бэкапа.
  await api.del(`/api/categories/${keptId}`);
  await api.post('/api/categories', { name: later });

  // Восстановление: подтверждение именем, экран обслуживания, перезагрузка по окончании.
  await page.reload();
  await page.getByRole('row', { name: new RegExp(name) }).getByRole('button', { name: 'Восстановить' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Введите имя бэкапа для подтверждения').fill(name);
  await dialog.getByRole('button', { name: 'Восстановить' }).click();
  const maintenance = page.getByRole('heading', { name: 'Идёт восстановление из бэкапа…' });
  await expect(maintenance).toBeVisible({ timeout: 120_000 });
  await expect(maintenance).toBeHidden({ timeout: 300_000 });

  // Повторный вход в чистом контексте браузера: данные — из бэкапа.
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const fresh = await ctx.newPage();
  await loginUi(fresh, ADMIN.login, ADMIN.password);
  await fresh.goto('/admin/categories');
  await expect(fresh.getByText(kept)).toBeVisible();
  await expect(fresh.getByText(later)).toHaveCount(0);
  await ctx.close();

  expect(await api.get<Operation>('/api/admin/backups/operation')).toMatchObject({
    type: 'restore',
    status: 'succeeded',
    backup: name,
    requestedBy: ADMIN.login,
  });

  // Уборка: категория вернулась вместе с бэкапом.
  const categories = await api.get<{ id: string; name: string }[]>('/api/categories');
  for (const c of categories.filter((c) => c.name === kept)) await api.del(`/api/categories/${c.id}`);
});
```

Почему сценарий не ломает остальные тесты: бэкап снимается в начале сценария, поэтому восстановление возвращает базу и бакет к состоянию перед ним. Пользователи и версии сессий те же, сессия `adminApi()` остаётся действительной. Redis очищается — кэш Carbone заполнится заново.

Run: `source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null && pnpm --filter @carbone-reports/e2e typecheck`
Expected: без ошибок. Сам сценарий прогоняется в Step 4 на живом стеке.

- [ ] **Step 2: README**

`README.md`, правки по местам.

1. «Файлы в S3-хранилище», пункт про `S3_ACCESS_KEY_ID`: фрагмент «выполните `docker compose up -d s3 api`, а если включён бэкап по расписанию — ещё и `docker compose --profile backup up -d backup` (иначе он продолжит работать со старыми ключами)» заменить на «выполните `docker compose up -d s3 api backup` (иначе агент бэкапа продолжит работать со старыми ключами)».
2. Строку «Сервис `s3` монтирует `docker/s3/entrypoint.sh` из каталога проекта, поэтому `docker compose` запускается из корня репозитория (как и для `backup`).» заменить на «Сервис `s3` монтирует `docker/s3/entrypoint.sh` из каталога проекта, поэтому `docker compose` запускается из корня репозитория.» (скрипты `backup` теперь в образе).
3. «Redis»:
   - в список того, что хранит Redis, добавить пункт `- флаг обслуживания \`cr:maintenance\` на время восстановления из бэкапа (его ставит и снимает агент бэкапа, см. [Бэкапы в админке](#бэкапы-в-админке)).`;
   - фразу «Redis подключён только к внутренней сети `cache` (`internal: true`), общей с `api`.» заменить на «Redis подключён только к внутренней сети `cache` (`internal: true`), общей с `api` и агентом бэкапа (сервис `backup`).».
4. «Запуск из готовых образов»:
   - `- \`ghcr.io/samrozhkov/carbone-report-backup\` (сервис \`backup\`: \`postgres:17-alpine\` + \`rclone\`);` → `- \`ghcr.io/samrozhkov/carbone-report-backup\` (сервис \`backup\`: агент бэкапа на Node поверх \`postgres:17-alpine\` + \`rclone\`);`;
   - строки `docker compose pull api web s3` и `docker compose --profile backup pull backup   # если используете бэкап` заменить одной: `docker compose pull api web s3 backup`.
5. «Обновление / выкат»:
   - после абзаца про `REDIS_PASSWORD` добавить: «Добавьте `BACKUP_AGENT_TOKEN` в `.env` перед обновлением до версии с управлением бэкапами из админки (`openssl rand -hex 32`, не короче 32 символов): без него `docker compose` не запустится. Сервис `backup` теперь запускается вместе со стеком (`docker compose up -d`), профиль `backup` больше не нужен.»;
   - `(\`docker compose --profile backup run --rm backup now\`)` → `(кнопка «Сделать бэкап» в админке или \`docker compose run --rm backup now\`)`.
6. «Резервное копирование»:
   - абзац «Образ сервиса `backup` собирается из `docker/backup/Dockerfile` (`postgres:17-alpine` и `rclone`): …» заменить на: «Сервис `backup` — агент бэкапа (`apps/backup-agent`, Node). Он запускается вместе со стеком, выполняет бэкап по расписанию и бэкапы и восстановление из админки ([Бэкапы в админке](#бэкапы-в-админке)) и вызывает те же скрипты `docker/backup/*.sh`. Образ собирается из `docker/backup/Dockerfile` с контекстом — корнем репозитория: `postgres:17-alpine`, `rclone`, Node, агент, скрипты и миграции `apps/api/drizzle` (по ним агент проверяет версию схемы бэкапа). Правка скриптов требует пересборки: `docker compose build backup`. Настройки S3 передаются `rclone` переменными окружения (`RCLONE_CONFIG_S3_*`), файла конфигурации с ключами нет.»;
   - в абзаце про каталоги после «Незавершённый бэкап остаётся с суффиксом `.partial` и не участвует в ротации.» добавить: «Бэкапы перед восстановлением называются `pre-restore-<время>`: `BACKUP_KEEP` на них не действует, хранятся 3 последних. В `backups/.op/` агент хранит состояние (`state.json`), замок `.op.lock` и журналы 20 последних операций.»;
   - блок «**По расписанию:**» (команда `docker compose --profile backup up -d backup` и строка «Имя сервиса `backup` в конце обязательно…») заменить на: «**По расписанию** бэкап запускает сам агент — сервис `backup` поднимается вместе со стеком (`docker compose up -d`). Если в момент запуска идёт другая операция (бэкап или восстановление из админки, ручной `now`), запуск по расписанию пропускается с записью в журнале.»;
   - в описании `BACKUP_CRON` фразу «Строка должна состоять ровно из 5 полей; иначе контейнер завершается с кодом 2 и сообщением «BACKUP_CRON: ожидается 5 полей cron» в журнале (и из-за `restart: unless-stopped` перезапускается с той же ошибкой, пока строку не исправят). Без проверки busybox `crond` молча проигнорировал бы неверное расписание;» заменить на «Строка должна состоять ровно из 5 полей; иначе контейнер завершается с кодом 2 и сообщением «BACKUP_CRON: ожидается 5 полей cron» в журнале (и из-за `restart: unless-stopped` перезапускается с той же ошибкой, пока строку не исправят). Неверное значение поля или часовой пояс — «BACKUP_CRON: неверное выражение … или часовой пояс TZ=…»;»;
   - в списке переменных добавить первым пунктом: `- \`BACKUP_AGENT_TOKEN\` — обязательный токен между \`api\` и агентом (не короче 32 символов, \`openssl rand -hex 32\`); без него \`docker compose\` не запускается;`;
   - `Журнал: \`docker compose --profile backup logs backup\`.` → `Журнал: \`docker compose logs backup\`.`;
   - блок «**Вручную**» — команду заменить на `docker compose run --rm backup now` и добавить под ней: «Ручной бэкап и агент не работают одновременно: если агент занят, команда завершается с кодом 75 и сообщением «идёт другая операция с бэкапами (агент) — повторите позже». Пока агент в состоянии «требуется восстановление» (см. ниже), ручной бэкап сохранил бы частично заменённую базу — сначала завершите восстановление.»;
   - заголовок «**Восстановление:**» заменить на «**Аварийное восстановление** (без веб-интерфейса; обычно восстановление запускается из админки):»;
   - пункт 3 списка шагов скрипта заменить на: «3. останавливает агент бэкапа (сервис `backup`): он не начнёт бэкап посреди замены файлов и не вернёт флаг обслуживания;»;
   - после пункта 6 вставить: «7. отмечает в `backups/.op/state.json` незавершённое восстановление из админки как `failed (resolved externally)`: после запуска агент больше не включает режим обслуживания;» и перенумеровать прежние 7 и 8 в 8 и 9; в бывшем пункте 8 текст «затем снова `backup`» сохранить.
7. Новый раздел — сразу после раздела «Резервное копирование» (перед «## Разработка интерфейса»):

```markdown
### Бэкапы в админке

Пункт «Бэкапы» в меню администратора появляется, когда у `api` заданы `BACKUP_AGENT_URL` и `BACKUP_AGENT_TOKEN` (в compose — всегда). Агент слушает порт 8080 только во внутренней сети `backup` между `api` и `backup`; наружу порт не публикуется, каждый запрос к нему, кроме `/health`, требует токен.

- **Список** — дата, имя каталога, тип (обычный или «перед восстановлением»), размер базы и файлов, последняя миграция, статус. Незавершённые (`.partial`) восстановить нельзя.
- **«Сделать бэкап»** — то же, что `docker compose run --rm backup now`. Над таблицей — последняя операция: кто запустил, этап, статус и журнал.
- **«Восстановить»** — после ввода имени бэкапа:
  1. проверка: контрольные суммы и версия схемы. Бэкап, сделанный более новой версией приложения, не восстанавливается;
  2. бэкап текущего состояния (`pre-restore-<время>`);
  3. режим обслуживания: все пользователи видят экран «Идёт восстановление из бэкапа…», API отвечает `503`;
  4. замена базы одной транзакцией, миграции до текущей схемы;
  5. восстановление файлов в бакете (`rclone sync`);
  6. очистка Redis.

  По окончании страница перезагрузится. Пользователь и версия его сессий берутся из восстановленной базы, поэтому может понадобиться войти заново, в том числе администратору.
- **Если восстановление упало после замены базы**, режим обслуживания остаётся. Агент печатает одноразовый код в журнал: `docker compose logs backup | grep 'КОД ВОССТАНОВЛЕНИЯ'`. На экране обслуживания введите код и выберите:
  - «Повторить восстановление из …»;
  - «Вернуть состояние до восстановления (pre-restore-…)».

  После 5 неверных попыток код заменяется новым; новый код печатается и при каждом новом сбое, и при перезапуске агента. Ввод кода ограничен 10 попытками за 15 минут с одного адреса.
- **Аварийный путь без веб-интерфейса** — `scripts/restore.sh` (см. выше). Он останавливает агент, отмечает незавершённое восстановление как выполненное вручную и очищает Redis вместе с флагом обслуживания.
```

8. «Конфигурация» — в конец раздела:

```markdown
`BACKUP_AGENT_URL` и `BACKUP_AGENT_TOKEN` — адрес агента бэкапа и общий токен (не короче 32 символов). Без адреса управление
бэкапами в админке выключено: `/api/admin/backups*` отвечают `404` с кодом `backups_disabled`, пункта меню нет. Адрес без
токена или короткий токен — ошибка конфигурации при старте. Агент недоступен или не ответил за 10 с — `502`
`backup_agent_unavailable` «Агент бэкапа недоступен». В Docker оба значения задаёт `docker-compose.yml`.
```

9. «Формат ошибок» — в конец раздела:

```markdown
Во время восстановления из бэкапа все маршруты, кроме `GET /api/health`, `GET /api/maintenance` и
`POST /api/maintenance/retry`, отвечают `503` с кодом `maintenance` и фазой в `details.phase`. Если Redis недоступен,
API работает как обычно: режим обслуживания включает только агент бэкапа, и он всегда пишет флаг в Redis.
```

```bash
cd /Users/sam/carbone-reports
grep -n -- '--profile backup' README.md .env.example scripts/restore.sh docker-compose.yml || echo 'нет упоминаний профиля backup'
```
Expected: остаётся только строка про ручной бэкап «старой версией» в «Перенос установки с тома `storage`» (там действительно старый compose с профилем).

- [ ] **Step 3: Подготовка живого прогона**

```bash
cd /Users/sam/carbone-reports
df -h /System/Volumes/Data | tail -1                       # ≥ 3 GiB, иначе BLOCKED
grep -q '^BACKUP_AGENT_TOKEN=.' .env || printf 'BACKUP_AGENT_TOKEN=%s\n' "$(openssl rand -hex 32)" >> .env
docker compose config --quiet && echo compose-ок
docker image ls --filter dangling=true --filter label=com.docker.compose.project=carbone-reports -q | xargs -r docker image rm
source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null && pnpm stack:demo
docker compose ps backup --format '{{.Service}} {{.Status}}'                  # backup Up … (healthy)
docker compose port backup 8080 || echo 'порт агента не опубликован'          # ожидается «не опубликован»
docker network inspect carbone-reports_backup --format 'internal={{.Internal}}'   # internal=true
docker compose logs backup | grep -m1 'агент бэкапа: порт 8080'               # расписание и TZ из .env
BASE_URL=https://localhost pnpm stack:smoke --insecure
df -h /System/Volumes/Data | tail -1
```

Скрипт сбоя и повтора — во временный файл (код восстановления в вывод не попадает, только статусы):

```bash
cat > "$TMPDIR/cr-restore-fail.mjs" <<'EOF'
// MODE=retry — сбой на этапе storage (остановлен s3), затем повтор по коду из журнала backup;
// MODE=fail  — только сбой: стек остаётся в состоянии «требуется восстановление».
import { execFileSync } from 'node:child_process';
process.loadEnvFile('.env');
const base = `https://localhost:${process.env.WEB_HTTPS_PORT ?? 443}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const json = { 'content-type': 'application/json' };
async function login() {
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({ login: process.env.ADMIN_LOGIN, password: process.env.ADMIN_PASSWORD }),
  });
  if (r.status !== 200) throw new Error(`вход: HTTP ${r.status}`);
  return (r.headers.get('set-cookie') ?? '').split(';')[0];
}
const maintenance = async () => (await fetch(`${base}/api/maintenance`)).json();
const cookie = await login();
const name = process.env.BK;
const r = await fetch(`${base}/api/admin/backups/${name}/restore`, { method: 'POST', headers: { ...json, cookie }, body: '{}' });
console.log(`восстановление из ${name}: HTTP ${r.status}`); // 202
let m = await maintenance();
while (!m.active) {
  await sleep(200);
  m = await maintenance();
}
console.log(`обслуживание включено, фаза ${m.phase}`); // maintenance
execFileSync('docker', ['compose', 'stop', 's3'], { stdio: 'inherit' });
for (let i = 0; i < 600 && !m.recovery; i++) {
  await sleep(1000);
  m = await maintenance();
}
console.log(`требуется восстановление: фаза ${m.phase}, цели ${JSON.stringify(m.recovery)}`); // storage
console.log(`API во время обслуживания: HTTP ${(await fetch(`${base}/api/templates`, { headers: { cookie } })).status}`); // 503
execFileSync('docker', ['compose', 'start', 's3'], { stdio: 'inherit' });
if (process.env.MODE !== 'retry') process.exit(0);
const retry = (code) =>
  fetch(`${base}/api/maintenance/retry`, { method: 'POST', headers: json, body: JSON.stringify({ code, target: 'same' }) });
console.log(`неверный код: HTTP ${(await retry('AAAA-AAAA-AAAA')).status}`); // 403
const logs = execFileSync('docker', ['compose', 'logs', 'backup'], { encoding: 'utf8' });
const code = [...logs.matchAll(/КОД ВОССТАНОВЛЕНИЯ: ([A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4})/g)].at(-1)?.[1];
if (!code) throw new Error('код не найден в журнале backup');
console.log(`верный код: HTTP ${(await retry(code)).status}`); // 202
do {
  await sleep(1000);
  m = await maintenance();
} while (m.active);
const after = await login();
const op = await (await fetch(`${base}/api/admin/backups/operation`, { headers: { cookie: after } })).json();
console.log(`операция: ${op.type} ${op.status} ${op.requestedBy}`); // restore succeeded recovery-code
EOF
```

- [ ] **Step 4: Живой прогон**

```bash
cd /Users/sam/carbone-reports
source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null

# 1. E2E дважды подряд (в том числе backups.spec.ts: бэкап → изменение → восстановление → вход).
pnpm e2e && pnpm e2e

# 2. Замок общий для контейнеров: пока его держит процесс в агенте, ручной now из отдельного контейнера — код 75.
docker compose exec -T backup sh -c '(exec 9>>/backups/.op.lock; flock -n 9 && sleep 30) >/dev/null 2>&1 &'
docker compose run --rm backup now; echo "rc=$?"                          # «идёт другая операция…», rc=75
sleep 30
BK_DIR=${BACKUP_DIR:-./backups}
BK=$(ls -1d "$BK_DIR"/????-??-??T??-??-??Z | sort | tail -1 | xargs basename); echo "$BK"
ls "$BK_DIR" | grep -c '^pre-restore-'                                     # ≤ 3

# 3. Сбой на этапе storage и повтор по коду.
NODE_TLS_REJECT_UNAUTHORIZED=0 MODE=retry BK="$BK" node "$TMPDIR/cr-restore-fail.mjs"
# Ожидание: 202; «обслуживание включено»; «требуется восстановление: фаза storage»; API 503;
# неверный код 403; верный код 202; «операция: restore succeeded recovery-code».

# 4. Аварийный путь: сбой из админки, затем scripts/restore.sh.
NODE_TLS_REJECT_UNAUTHORIZED=0 MODE=fail BK="$BK" node "$TMPDIR/cr-restore-fail.mjs"
curl -sk "https://localhost:${WEB_HTTPS_PORT:-443}/api/maintenance" | grep -o '"active":true'   # флаг стоит
printf 'restore\n' | scripts/restore.sh "$BK_DIR/$BK"                   # «Восстановление завершено.»
docker compose ps backup --format '{{.Service}} {{.Status}}'           # агент снова запущен
docker compose exec -T backup grep -c 'resolved externally' /backups/.op/state.json   # 1
sleep 12                                                                 # два периода повтора флага
curl -sk "https://localhost:${WEB_HTTPS_PORT:-443}/api/maintenance"     # {"active":false}

# 5. Секреты не попали в журналы (печатается только число совпадений).
( set -a; . ./.env; set +a; docker compose logs backup api 2>&1 | grep -cF -e "$POSTGRES_PASSWORD" -e "$S3_SECRET_ACCESS_KEY" -e "$REDIS_PASSWORD" -e "$BACKUP_AGENT_TOKEN" -e "$ADMIN_PASSWORD" ) || true   # 0

# 6. Стек после всех восстановлений.
BASE_URL=https://localhost pnpm stack:smoke --insecure
pnpm e2e                                                                 # третий прогон, все зелёные
rm -f "$TMPDIR/cr-restore-fail.mjs"
docker image ls --filter dangling=true --filter label=com.docker.compose.project=carbone-reports -q | xargs -r docker image rm
df -h /System/Volumes/Data | tail -1
```

`WEB_HTTPS_PORT` в командах `curl` берётся из окружения оболочки; если в `.env` задан другой порт, подставить его вручную.

Стек оставить запущенным, `down` не делать. Если `backup` не стал healthy, смотреть `docker compose logs backup`:
- код 2 и `BACKUP_CRON: …` или `BACKUP_AGENT_TOKEN: …` — ошибка в `.env`;
- `rclone не найден` — образ не пересобран.

Если флаг не снимается, смотреть `docker compose exec -T backup cat /backups/.op/state.json`: там только sha256 кода, сам код — в журнале. Аварийный выход — `scripts/restore.sh`. Падения E2E разбирать по `e2e/report`; таймауты не поднимать.

- [ ] **Step 5: Заметки**

`docs/superpowers/notes/2026-10-02-backend-follow-ups.md` — в конец файла. В угловых скобках — значения из Step 3–4:

```markdown

## Итоги Плана 15 (бэкапы в админке)

- **Агент бэкапа** (`apps/backup-agent`, Fastify):
  - работает в образе `backup` (`postgres:17-alpine` + `rclone` + `nodejs`, многоэтапная сборка из корня репозитория; скрипты и миграции `apps/api/drizzle` — в образе);
  - вызывает `backup.sh`, `entrypoint.sh restore-storage` и `lib.sh` как дочерние процессы;
  - cron — `croner` (5 полей, `TZ`), `crond` удалён; режимы `entrypoint.sh`: `agent`, `now`, `restore-storage`;
  - HTTP на 8080 только в сети `backup`, Bearer-токен (сравнение sha256 за постоянное время, ≥ 32 символов).
- **Одна операция за раз:**
  - замок в процессе и `flock` на `/backups/.op.lock` через держатель с открытым stdin (снимается при смерти агента);
  - `now` при занятом замке выходит с кодом 75;
  - в состоянии «требуется восстановление» бэкап (и cron) отклоняются, чтобы не вытеснить исправные копии.
- **Восстановление:**
  - фазы `verify → pre-backup → maintenance → db → migrate → storage → redis → done`, каждая — в `state.json` (tmp + rename);
  - версия схемы — по хешам drizzle (sha256 SQL-файла) из образа;
  - `pg_terminate_backend` для `application_name = 'api'` через 3 с;
  - `pre-restore-*` — 3 последних.
- **Флаг `cr:maintenance`:**
  - все записи — одной очередью, значение вычисляется при записи (повтор не возвращает снятый флаг);
  - повтор каждые 5 с, пока идут фазы 3–7 или требуется восстановление; неудачный DEL повторяется таймером.
- **Коды восстановления:**
  - 12 символов base32, только в stdout (`docker compose logs backup`), в `state.json` — sha256;
  - 5 неверных попыток — новый код; новый код при каждом сбое и при рестарте агента;
  - `restore.sh` отмечает `failed (resolved externally)` через `node /agent/dist/main.js resolve-external`.
- **API:**
  - модуль `backups` (прокси, admin, 10 с, 502 `backup_agent_unavailable`, 404 `backups_disabled`);
  - `features.backups` в `/api/auth/me` и ответе входа;
  - middleware обслуживания (кэш 1 с, фоновое обновление, fail-open) и публичные `/api/maintenance`, `/api/maintenance/retry` (10 за 15 минут с IP);
  - все пулы — `application_name: 'api'`, у основного пула — обработчик `error`;
  - пулы источников данных сбрасываются при снятии флага.
- **Web:**
  - «Бэкапы» (таблица, панель операции с опросом 2 с, подтверждение точным именем);
  - экран обслуживания над роутером (опрос 3 с, перезагрузка, форма кода).
- **Решения по спецификации:**
  - коды `backups_disabled`, `backup_agent_unavailable`, `maintenance` — строчными, как в §26;
  - 409 агента — `{ error, busy }` (надмножество `{ busy }`);
  - `GET /operation` без операций — 204;
  - `startedAt: null` в `busy`, если замок держит ручной `now`;
  - адрес агента без токена — ошибка конфигурации API, токен без адреса — функция выключена;
  - `requestedBy` повтора по коду — `recovery-code`;
  - каталог без `manifest.txt` — `partial`.
- **Живой прогон:**
  - свободно на диске <X> GiB до сборки и <Y> GiB после; образ `backup` <SIZE>;
  - `backup` healthy, порт 8080 не опубликован, сеть `backup` внутренняя;
  - smoke пройден; E2E <M>/<M> дважды подряд и третий раз после восстановлений, нарушений CSP 0;
  - сбой на `storage` (остановлен `s3`) → флаг остался, API 503, неверный код 403, повтор по коду из журнала — успех;
  - `restore.sh` из состояния «требуется восстановление» — завершён, `state.json` отмечен `resolved externally`, флаг через 12 с не вернулся;
  - совпадений секретов в журналах `backup` и `api` — 0;
  - стек оставлен запущенным.
- **Возможные улучшения:**
  - отдельная учётная запись S3 только для чтения у бэкапа;
  - скачивание и удаление бэкапов из админки (вне Плана 15);
  - восстановление в k8s — План 16.
```

- [ ] **Step 6: Гейты и коммит**

```bash
cd /Users/sam/carbone-reports
source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null && pnpm exec prettier --write e2e/tests/backups.spec.ts README.md && pnpm typecheck && pnpm lint && pnpm exec prettier --check . && pnpm test
git status --short                           # .env, certs/, backups/ не в списке
git add e2e/tests/backups.spec.ts README.md docs/superpowers/notes/2026-10-02-backend-follow-ups.md
git commit -m "test(e2e): backup and restore from the admin UI; docs: backups in admin, emergency restore.sh, Plan 15 notes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

Если живой прогон выявил ошибку в коде Task 1–8: исправить её отдельным коммитом с тестом, который её ловит, повторить гейты (с `test:int` изменённого пакета) и Step 4 и указать это в итогах.
