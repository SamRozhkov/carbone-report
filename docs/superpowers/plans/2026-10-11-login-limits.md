# Carbone Reports — План 10: защита Redis и лимиты входа

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Закрыть Redis паролем и отдельной сетью. Оставить лимит входа рабочим при сбое Redis (запасной счётчик в памяти). Добавить лимит входа по IP клиента.

**Architecture:**
- Compose: `--requirepass`, сеть `cache` с `internal: true`, `REDIS_URL` с паролем.
- `apps/api/src/lib/fallback-store.ts` — хранилище `@fastify/rate-limit`. Оно делегирует встроенному `RedisStore`, а при ошибке Redis — встроенному `LocalStore`, с автоматом на 5 секунд.
- Лимит по IP — второй лимитер `app.createRateLimit(...)` в `preHandler` маршрута входа.
- `trustProxy: 1`.

**Tech Stack:** Redis 7 (`requirepass`), ioredis 5, `@fastify/rate-limit` 11.2 (`store`, `createRateLimit`), Fastify `trustProxy`, testcontainers.

**Spec:** `docs/superpowers/specs/2026-10-02-carbone-reports-design.md`, §21.

## Global Constraints

- `REDIS_PASSWORD` — только hex. В compose: `${REDIS_PASSWORD:?задайте REDIS_PASSWORD в .env}`.
- Пароль нигде не передаётся аргументом командной строки, кроме самого `redis-server` (`--requirepass` в `command` неизбежен). `redis-cli` получает его через `REDISCLI_AUTH`. В логи пароль не пишется.
- Сеть `cache: { internal: true }`: в ней `redis` (только эта сеть) и `api` (`default` + `cache`).
- Пространства ключей лимитов: по логину — `cr:rl:` (как сейчас), по IP — `cr:rl-ip:`.
- Лимиты:
  - по логину — 10 в минуту, сообщение прежнее;
  - по IP — 30 в минуту, `TOO_MANY_ATTEMPTS` 429 «слишком много попыток входа с этого адреса, повторите через минуту».
- Автомат запасного хранилища — 5000 мс.
- `trustProxy: 1`.
- Тексты на русском.
- Гейты:
  - всегда: `pnpm typecheck && pnpm lint && pnpm exec prettier --check . && pnpm test`;
  - при изменениях API: ещё `pnpm test:int`.
- Docker:
  - перед `build`/`up` проверить `df -h /System/Volumes/Data`: если свободно меньше 2 ГБ — BLOCKED;
  - `down` без `-v`;
  - удалять только висячие образы `carbone-reports`.
- Локальный `.env` разработчика: если в нём нет `REDIS_PASSWORD`, добавить `REDIS_PASSWORD=$(openssl rand -hex 32)`. `.env` не коммитится.

## Review Focus

1. **Существующая установка без `REDIS_PASSWORD`.** Ожидание: `docker compose up` падает сразу с понятным текстом, ничего не запущено наполовину. Проверка: Task 1.
2. **Redis отвечает «NOAUTH» или «WRONGPASS» (неверный пароль).** Ожидание: API работает как при недоступном Redis — кэш промахивается, лимит считается в памяти, а в логе предупреждение. Проверка: Task 1, Task 2.
3. **Redis падает посреди потока входов.** Ожидание: 11-я неверная попытка за минуту всё равно даёт 429 (в пределах экземпляра), и запрос не ждёт таймаут Redis на каждой попытке. Проверка: Task 2.
4. **Клиент подставляет `X-Forwarded-For: 1.2.3.4`.** Ожидание: лимит по IP считается по адресу, который видит nginx, а не по подставленному. Проверка: Task 3.
5. **Много пользователей за одним NAT.** Ожидание: лимит по IP (30 в минуту) не мешает обычной работе. Успешные входы тоже учитываются, но 30 в минуту с одного адреса — с запасом. Порог задокументирован. Проверка: Task 3 (README).

## Структура файлов

```
docker-compose.yml, .env.example        REDIS_PASSWORD, сеть cache, REDIS_URL с паролем, healthcheck через REDISCLI_AUTH
scripts/restore.sh                      FLUSHALL с REDISCLI_AUTH
apps/api/src/lib/fallback-store.ts      FallbackStore (+ тест)
apps/api/src/app.ts                     store: FallbackStore, trustProxy: 1, createRateLimit для IP
apps/api/src/modules/auth/routes.ts     лимит по IP в preHandler входа
apps/api/test/global-setup.ts           Redis с паролем
apps/api/test/*.int.test.ts             тесты
README.md, docs/superpowers/notes/...
```

---

### Task 1: Пароль и сеть Redis

**Files:**
- Modify:
  - `docker-compose.yml`, `.env.example`
  - `scripts/restore.sh`
  - `apps/api/test/global-setup.ts`, `apps/api/test/helpers.ts`
  - `apps/api/test/redis.int.test.ts`
  - `README.md`

- [ ] **Step 1: Compose**

```yaml
  redis:
    image: redis:7-alpine
    command: ['sh', '-c', 'exec redis-server --requirepass "$$REDIS_PASSWORD" --save "" --appendonly no --maxmemory 128mb --maxmemory-policy volatile-lru']
    environment:
      REDIS_PASSWORD: ${REDIS_PASSWORD:?задайте REDIS_PASSWORD в .env}
      REDISCLI_AUTH: ${REDIS_PASSWORD:?задайте REDIS_PASSWORD в .env}
    healthcheck:
      test: ['CMD', 'redis-cli', 'ping']
    networks: [cache]
    # остальное без изменений
  api:
    environment:
      REDIS_URL: redis://:${REDIS_PASSWORD:?задайте REDIS_PASSWORD в .env}@redis:6379
    networks: [default, cache]
networks:
  cache:
    internal: true
```

- Через `sh -c … "$$REDIS_PASSWORD"` пароль не появляется в `docker inspect` в виде команды. В `environment` контейнера он всё равно есть — это допустимо.
- Проверьте, что `redis-cli ping` с `REDISCLI_AUTH` в окружении отвечает `PONG`.
- Если у сервисов в compose уже есть явные `networks`, учтите это. Сейчас все используют `default`, поэтому достаточно добавить `cache`.
- Проверьте, что dev-переопределение (`docker-compose.dev.yml`) для `api` не теряет сеть `cache`. Compose объединяет списки `networks`, но убедитесь в этом через `docker compose -f docker-compose.yml -f docker-compose.dev.yml config`.

`.env.example`:
```dotenv
# Пароль Redis (кэш и лимиты входа), только hex: openssl rand -hex 32
REDIS_PASSWORD=
```

Проверка (Review Focus 1):
```bash
env -u REDIS_PASSWORD docker compose --env-file /dev/null config 2>&1 | grep -c "задайте REDIS_PASSWORD"
docker compose config | grep -A3 "^  redis:" ; docker compose config | grep -n "internal: true"
```
Первая команда может упереться и в другие обязательные переменные. Важно, чтобы при наличии остальных переменных и отсутствии `REDIS_PASSWORD` появлялось именно это сообщение. Проще всего — временная копия `.env` без строки `REDIS_PASSWORD`, переданная через `--env-file`.

- [ ] **Step 2: restore.sh**

Вызов `FLUSHALL` использует пароль из окружения контейнера: `docker compose exec -T redis sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli FLUSHALL'`. Раз в окружении `redis` уже есть `REDISCLI_AUTH`, хватит и простого `redis-cli FLUSHALL` — проверьте. Ни пароль, ни `.env` в скрипте не читаются.

- [ ] **Step 3: Тесты**

- `global-setup.ts`: Redis в testcontainers запускается с `--requirepass <случайный hex>`, а `provide('redisUrl', 'redis://:<pass>@host:port')`.
- `redis.int.test.ts`, новые тесты:
  1. Клиент без пароля: команды отклоняются с `NOAUTH`. `redisTemplateCache` считает это промахом, рендер проходит.
  2. Клиент с неверным паролем (`WRONGPASS`): рендер проходит быстрее 1,5 с, предупреждение пишется в лог (проверить через переданный `log`).
  3. Клиент с верным паролем: кэш общий, как раньше.

Сверьте, как ioredis сообщает об ошибке аутентификации: событием `error` или отказом в команде. Предупреждение должно появляться (Review Focus 2).

- [ ] **Step 4: Живая проверка**

```bash
grep -q '^REDIS_PASSWORD=.\+' .env || echo "REDIS_PASSWORD=$(openssl rand -hex 32)" >> .env
df -h /System/Volumes/Data | tail -1
pnpm stack:demo
docker compose ps redis --format '{{.Health}}'                               # healthy
docker compose exec -T redis sh -c 'redis-cli -a wrong --no-auth-warning ping' # NOAUTH или WRONGPASS
docker run --rm --network carbone-reports_default redis:7-alpine redis-cli -h redis ping   # не резолвится или нет доступа: Redis не в сети default
BASE_URL=https://localhost:${WEB_HTTPS_PORT:-443} pnpm stack:smoke -- --insecure
```
Стек оставьте поднятым, если следующая задача идёт сразу. Иначе — `down` без `-v`.

- [ ] **Step 5: README, гейты, коммит**

README, раздел Redis: пароль, внутренняя сеть, обязательная переменная при обновлении. В «Обновление / выкат» добавить строку: «добавьте `REDIS_PASSWORD` в `.env` перед обновлением».

```bash
pnpm typecheck && pnpm lint && pnpm exec prettier --check . && pnpm test && pnpm test:int
git add docker-compose.yml .env.example scripts/restore.sh apps/api/test README.md
git commit -m "feat(ops): redis password and internal cache network"
```

---

### Task 2: Запасное хранилище лимита

**Files:**
- Create: `apps/api/src/lib/fallback-store.ts`, `apps/api/src/lib/fallback-store.test.ts`
- Modify: `apps/api/src/app.ts`, `apps/api/test/rate-limit-redis.int.test.ts`

**Interfaces:**
- Produces: `fallbackStore(opts: { breakMs?: number; log?: { warn(o: object, m: string): void } }): FastifyRateLimitStoreCtor`. Это конструктор хранилища. В контексте плагина он создаёт `RedisStore` и `LocalStore` из самого `@fastify/rate-limit` (проверьте пути импорта: `@fastify/rate-limit/store/RedisStore.js`, `LocalStore.js` и их сигнатуры конструкторов в 11.2).

- [ ] **Step 1: Модульные тесты (с фейками основного и запасного хранилища)**

1. Основное хранилище успешно: `incr` уходит в Redis, а `LocalStore` не трогается.
2. Основное отвечает ошибкой: этот же вызов уходит в `LocalStore`, ошибка наружу не выходит. В течение 5 с последующие вызовы идут сразу в `LocalStore`, без обращения к Redis. После 5 с снова пробуется Redis (фейковые часы).
3. При переходе на запасное хранилище предупреждение пишется не чаще одного раза за период автомата.
4. `child(routeOptions)` возвращает хранилище с тем же поведением. Плагин вызывает `child` для маршрутных настроек — проверьте по исходнику, где и как.

- [ ] **Step 2: Реализация**

```ts
export function fallbackStore(opts) {
  return class FallbackStore {
    constructor(options) { /* primary = new RedisStore(...), local = new LocalStore(...) — по сигнатурам 11.2 */ }
    incr(key, cb, timeWindow, max) {
      if (Date.now() < this.openUntil) return this.local.incr(key, cb, timeWindow, max);
      this.primary.incr(key, (err, res) => {
        if (!err) return cb(null, res);
        this.trip();
        this.local.incr(key, cb, timeWindow, max);
      }, timeWindow, max);
    }
    child(routeOptions) { /* новый FallbackStore для маршрута, автомат общий для экземпляра */ }
  };
}
```
Точные параметры `incr` и `child` возьмите из `node_modules/@fastify/rate-limit/store/*.js` и `types/index.d.ts` версии 11.2. Состояние автомата (`openUntil`) общее для всех `child` одного экземпляра API.

`app.ts`:
```ts
await app.register(rateLimit, {
  global: false,
  ...(deps.redis ? { redis: deps.redis, store: fallbackStore({ log: app.log }) } : {}),
});
```
Убрать `skipOnError`. Пространство ключей `cr:rl:` сохранить — проверьте, как `RedisStore` получает `nameSpace` в 11.2.

- [ ] **Step 3: Интеграционные тесты (Review Focus 2, 3)**

`rate-limit-redis.int.test.ts`:
- Существующий тест «два экземпляра, общий лимит» остаётся зелёным.
- Тест «Redis недоступен» меняет ожидание: 11-я неверная попытка за минуту даёт 429, потому что лимит в памяти. Каждый ответ приходит быстрее 1 с, а суммарное время 12 попыток меньше 2 с — автомат не ждёт Redis на каждом запросе.
- Неверный пароль Redis: то же поведение.

- [ ] **Step 4: Гейты, коммит**

```bash
pnpm --filter @carbone-reports/api test && pnpm --filter @carbone-reports/api test:int
pnpm typecheck && pnpm lint && pnpm exec prettier --check . && pnpm test
git add apps/api
git commit -m "feat(api): login limit falls back to memory when redis fails"
```

---

### Task 3: Лимит входа по IP

**Files:**
- Modify:
  - `apps/api/src/app.ts` (`trustProxy: 1`)
  - `apps/api/src/modules/auth/routes.ts`
  - `apps/api/test/auth.int.test.ts` или новый `login-ip-limit.int.test.ts`
  - `README.md`, заметка

- [ ] **Step 1: Тесты (RED)**

1. 30 запросов входа с разными логинами (неверными) от одного IP проходят, 31-й даёт 429 `TOO_MANY_ATTEMPTS` «слишком много попыток входа с этого адреса, повторите через минуту». IP задаётся через `X-Forwarded-For: 10.0.0.1` в `inject`, так как nginx в тестах нет и прокси эмулируется заголовком. При `trustProxy: 1` берётся последний адрес заголовка. Сверьте с документацией Fastify и `proxy-addr`.
2. Другой IP (`10.0.0.2`) после этого не ограничен.
3. Подделка (Review Focus 4): клиент шлёт `X-Forwarded-For: 1.2.3.4, 10.0.0.1`, где `1.2.3.4` — подставлен клиентом, а `10.0.0.1` добавил nginx. Учитывается `10.0.0.1`. После 30 таких запросов запрос с `X-Forwarded-For: 5.6.7.8, 10.0.0.1` тоже получает 429.
4. Лимит по логину работает как раньше: 11-я попытка одного логина даёт 429 с прежним текстом.

- [ ] **Step 2: Реализация**

- `createFastify`: `Fastify({ ..., trustProxy: 1 })`. Проверьте, что существующие тесты и логи (`remoteAddress` в сериализаторе, если есть) не сломались.
- `auth/routes.ts`: создать лимитер `const ipLimit = app.createRateLimit({ max: 30, timeWindow: '1 minute', keyGenerator: (req) => req.ip, nameSpace: 'cr:rl-ip:' })`. Проверьте поддержку `nameSpace` и `store` в `createRateLimit` 11.2: лимитер должен использовать то же хранилище с запасом в памяти. В `preHandler` маршрута входа:
```ts
const r = await ipLimit(req);
if (r.isExceeded) throw new AppError('TOO_MANY_ATTEMPTS', 429, 'слишком много попыток входа с этого адреса, повторите через минуту');
```
- Порядок с маршрутным `rateLimit` по логину: оба лимита работают независимо, срабатывает тот, что исчерпан первым.

- [ ] **Step 3: Живой прогон**

```bash
df -h /System/Volumes/Data | tail -1
docker compose --profile demo up -d --build --wait api   # если стек поднят; иначе pnpm stack:demo
pnpm e2e && pnpm e2e
BASE_URL=https://localhost:${WEB_HTTPS_PORT:-443} pnpm stack:smoke -- --insecure
# лимит по IP через nginx: 31 неверный вход с разными логинами → 31-й 429
docker compose stop redis   # лимит по логину остаётся (в памяти): 11-я попытка → 429
docker compose start redis
docker compose --profile demo down
```
Если E2E упирается в лимит по IP (все тесты идут с одного адреса), не поднимайте порог. Убедитесь, что E2E переиспользует сессии (`adminApi`, `loginAdminUi`) — так уже сделано. Если всё равно упирается, опишите в отчёте число входов за прогон.

Удалить висячие образы `carbone-reports`.

- [ ] **Step 4: Документация, коммит**

- README:
  - лимиты входа: по логину 10 в минуту, по IP 30 в минуту;
  - что происходит при сбое Redis: лимиты продолжают действовать по каждому экземпляру API;
  - IP берётся от nginx (`trustProxy: 1`); если перед nginx стоит ещё один прокси, значение нужно увеличить, а это изменение кода;
  - пользователи за общим NAT делят лимит по IP.
- Заметка: «Итоги Плана 10». Закрыть пункты про пароль и сеть Redis, fail-open лимит и лимит по IP.

```bash
pnpm typecheck && pnpm lint && pnpm exec prettier --check . && pnpm test
git add apps/api README.md docs/superpowers/notes
git commit -m "feat(api): per-IP login limit behind nginx"
```
