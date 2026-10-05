# Carbone Reports — План 4: укрепление

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Закрыть отложенные пункты безопасности и надёжности перед выходом к реальным пользователям:
- отзыв сессий;
- режимы SSL источников со своим CA;
- срок жизни callback-токена OnlyOffice;
- атомарная запись файла шаблона;
- проверка восстановления Carbone и непокрытые тесты.

**Architecture:** Изменения точечные, в существующих модулях `apps/api`, `apps/web` и `packages/shared`. Схема БД меняется миграциями drizzle-kit. Миграция с переносом данных (`ssl` → `ssl_mode`) правится вручную после генерации. Файлы шаблонов переезжают на пути с версией, их перенос выполняется при старте API.

**Tech Stack:** Fastify 5, drizzle 0.45 + drizzle-kit 0.31, jose, pg, React 19 + Gravity UI, Vitest 5, testcontainers 12, Playwright 1.63.

**Spec:** `docs/superpowers/specs/2026-10-02-carbone-reports-design.md`, §15 (также §5, §7, §14).

## Global Constraints

- Node 22 (`source ~/.nvm/nvm.sh >/dev/null && nvm use 22 >/dev/null`), pnpm 10.34.6, TypeScript strict.
- Docker runtime — OrbStack. Перед `build` и `up` проверять `df -h /System/Volumes/Data`. Если свободно меньше 2 ГБ — BLOCKED. Удалять только висячие образы `carbone-reports`, созданные в задаче. Чужие образы, кэш и тома не трогать.
- `.env` и `certs/` не коммитятся.
- Тексты для пользователя и сообщения об ошибках API — на русском.
- Новые колонки БД добавляются миграцией: `pnpm --filter @carbone-reports/api db:generate --name <имя>`. Сгенерированный SQL коммитится вместе с `drizzle/meta`. Ручные правки SQL допускаются только там, где это прямо сказано в задаче.
- Перед коммитом: `pnpm typecheck && pnpm lint && pnpm exec prettier --check . && pnpm test`. Задачи, которые меняют `apps/api`, дополнительно гоняют `pnpm test:int` (testcontainers).
- Ответ об ошибке API имеет прежний формат (`AppError`). Новые коды ошибок: `SESSION_REVOKED` не вводится, отозванная сессия даёт обычный 401 `UNAUTHORIZED`.
- E2E (`pnpm e2e`) запускается против `pnpm stack:demo`. Тесты используют одну сессию админа (`adminApi()` / `loginAdminUi`), потому что вход ограничен 10 попытками в минуту.

## Review Focus

1. **Админ меняет собственный пароль.** Ожидание: его текущая вкладка продолжает работать, потому что выставляется новая cookie, а сессии на других устройствах завершаются. Проверка: Task 1.
2. **Источник с `ssl=true` после миграции.** Ожидание: он работает так же, как раньше (`require`, без проверки сертификата), а форма показывает режим «SSL без проверки сертификата». Проверка: Task 3 (миграция + интеграционный тест).
3. **Document Server повторяет callback после 403 из-за просроченного токена.** Ожидание: повтор со свежим токеном сохраняет версию, а старый перехваченный токен отклоняется. Проверка: Task 5.
4. **Сбой БД после записи нового файла.** Ожидание: шаблон остаётся на прежней версии и прежнем файле, отчёты формируются. Проверка: Task 6.
5. **API стартует со старыми путями файлов** (`templates/<id>.<ext>`). Ожидание: файлы переносятся в `templates/<id>/v<version>.<ext>`. Повторный старт ничего не ломает. Если файла нет, это не мешает старту. Проверка: Task 6.

## Структура файлов

```
apps/api/
  drizzle/0001_*.sql, 0002_*.sql, meta/*        миграции (session_version; ssl_mode/ssl_ca)
  src/db/schema.ts                               + users.sessionVersion; datasources.sslMode/sslCa
  src/modules/auth/session.ts                    sv в JWT
  src/modules/auth/guards.ts                     сверка sv
  src/modules/auth/routes.ts                     logout-all, общий setSessionCookie
  src/modules/users/routes.ts                    bump session_version, revoke
  src/modules/datasources/pools.ts               sslOptions()
  src/modules/datasources/routes.ts              sslMode/sslCa в DTO
  src/modules/onlyoffice/jwt.ts                  verifyOnlyOfficeCallback (exp/iat)
  src/modules/onlyoffice/callback.ts             скачивание до блокировки, путь с версией
  src/modules/templates/service.ts               templateFilePath(id, ext, version)
  src/modules/templates/routes.ts                PUT /file, insert, delete, duplicate с новым путём
  src/modules/templates/file-migration.ts        перенос старых путей при старте
  src/server.ts                                  вызов migrateTemplateFiles
  test/*.int.test.ts                             новые и обновлённые тесты
packages/shared/src/index.ts                     SslMode, DatasourceBody.sslMode/sslCa
apps/web/src/api/endpoints.ts                    users.revokeSessions, logoutAll
apps/web/src/pages/admin/UsersPage.tsx           «Завершить сессии»
apps/web/src/app/Layout.tsx                      «Выйти везде»
apps/web/src/pages/admin/DatasourceDialog.tsx    режим SSL + PEM
apps/web/src/pages/admin/DatasourcesPage.tsx     колонка SSL по режиму
scripts/smoke.ts                                 --carbone-restart
scripts/demo-seed.ts                             sslMode
e2e/tests/sessions.spec.ts                       сценарий «Завершить сессии»
docs/superpowers/notes/2026-10-02-backend-follow-ups.md
```

---

### Task 1: Отзыв сессий в API

**Files:**
- Modify:
  - `apps/api/src/db/schema.ts`
  - `apps/api/src/modules/auth/session.ts`
  - `apps/api/src/modules/auth/guards.ts`
  - `apps/api/src/modules/auth/routes.ts`
  - `apps/api/src/modules/users/routes.ts`
- Create: миграция `apps/api/drizzle/0001_session_version.sql` (генерируется)
- Test: `apps/api/test/auth.int.test.ts`, `apps/api/src/modules/auth/session.test.ts` (если такого файла нет, создать)

**Interfaces:**
- Produces:
  - `SessionUser` не меняется. Новый тип `SessionClaims = SessionUser & { sv: number }`.
  - `signSession(user: SessionUser, sv: number, secret: Uint8Array): Promise<string>`.
  - `verifySession(token, secret): Promise<SessionClaims | null>`. Возвращает `null`, если `sv` не целое число.
  - `setSessionCookie(reply: FastifyReply, deps: AppDeps, user: SessionUser, sv: number): Promise<void>` — новый экспорт `apps/api/src/modules/auth/routes.ts`.
  - API:
    - `POST /api/auth/logout-all` (requireUser) → 204, увеличивает `session_version` текущего пользователя, очищает cookie;
    - `POST /api/users/:id/sessions/revoke` (requireAdmin) → 204; для собственного id → 400 «нельзя завершить собственные сессии — используйте «Выйти везде»»; несуществующий → 404.
  - `PATCH /api/users/:id` при изменении `password`, `role` или `blocked` увеличивает `session_version`. Если `:id` — текущий пользователь, в ответе выставляется новая cookie.

- [ ] **Step 1: Схема и миграция**

`apps/api/src/db/schema.ts`, таблица `users`, после `blocked`:
```ts
  sessionVersion: integer('session_version').notNull().default(0),
```
Затем:
```bash
pnpm --filter @carbone-reports/api db:generate --name session_version
```
Expected: появился `apps/api/drizzle/0001_session_version.sql` с `ALTER TABLE "users" ADD COLUMN "session_version" integer DEFAULT 0 NOT NULL;`.

- [ ] **Step 2: Падающие тесты**

В `apps/api/test/auth.int.test.ts` добавить в конец (`loginAs`, `t` и прочие хелперы уже есть в файле, имена сверить с его шапкой):
```ts
describe('отзыв сессий', () => {
  const me = (cookie: string) =>
    t.app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });

  it('смена пароля админом завершает все сессии пользователя', async () => {
    const admin = await loginAs(t, 'admin');
    const u = await loginAs(t, 'user');
    expect((await me(u.cookie)).statusCode).toBe(200);
    const r = await t.app.inject({
      method: 'PATCH',
      url: `/api/users/${u.user.id}`,
      headers: { cookie: admin.cookie },
      payload: { password: 'new-password-1' },
    });
    expect(r.statusCode).toBe(200);
    expect((await me(u.cookie)).statusCode).toBe(401);
  });

  it('смена роли завершает сессии', async () => {
    const admin = await loginAs(t, 'admin');
    const u = await loginAs(t, 'user');
    await t.app.inject({
      method: 'PATCH',
      url: `/api/users/${u.user.id}`,
      headers: { cookie: admin.cookie },
      payload: { role: 'admin' },
    });
    expect((await me(u.cookie)).statusCode).toBe(401);
  });

  it('админ меняет собственный пароль: текущая сессия продолжается по новой cookie, старая cookie недействительна', async () => {
    const admin = await loginAs(t, 'admin');
    const r = await t.app.inject({
      method: 'PATCH',
      url: `/api/users/${admin.user.id}`,
      headers: { cookie: admin.cookie },
      payload: { password: 'new-password-2' },
    });
    expect(r.statusCode).toBe(200);
    const fresh = String(r.headers['set-cookie']).split(';')[0]!;
    expect(fresh).toMatch(/^session=/);
    expect((await me(fresh)).statusCode).toBe(200);
    expect((await me(admin.cookie)).statusCode).toBe(401);
  });

  it('admin завершает сессии пользователя; свои — нельзя; несуществующий — 404', async () => {
    const admin = await loginAs(t, 'admin');
    const u = await loginAs(t, 'user');
    const revoke = (id: string) =>
      t.app.inject({
        method: 'POST',
        url: `/api/users/${id}/sessions/revoke`,
        headers: { cookie: admin.cookie },
      });
    expect((await revoke(u.user.id)).statusCode).toBe(204);
    expect((await me(u.cookie)).statusCode).toBe(401);
    expect((await revoke(admin.user.id)).statusCode).toBe(400);
    expect((await revoke('00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
  });

  it('user не может завершать чужие сессии', async () => {
    const u = await loginAs(t, 'user');
    const v = await loginAs(t, 'user');
    const r = await t.app.inject({
      method: 'POST',
      url: `/api/users/${v.user.id}/sessions/revoke`,
      headers: { cookie: u.cookie },
    });
    expect(r.statusCode).toBe(403);
  });

  it('«Выйти везде» завершает все сессии текущего пользователя и очищает cookie', async () => {
    const u = await loginAs(t, 'user');
    const r = await t.app.inject({
      method: 'POST',
      url: '/api/auth/logout-all',
      headers: { cookie: u.cookie },
    });
    expect(r.statusCode).toBe(204);
    expect(String(r.headers['set-cookie'])).toMatch(/session=;/);
    expect((await me(u.cookie)).statusCode).toBe(401);
  });

  it('cookie без sv (выпущенная до обновления) недействительна', async () => {
    const u = await loginAs(t, 'user');
    const { SignJWT } = await import('jose');
    const legacy = await new SignJWT({ login: u.user.login, role: u.user.role })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(u.user.id)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(t.deps.config.appSecret);
    expect((await me(`session=${legacy}`)).statusCode).toBe(401);
  });
});
```
Хелпер `loginAs(t, role)` создаёт нового пользователя и входит им, возвращая `{ cookie, user }`. Сверьте сигнатуру с `apps/api/test/helpers.ts`.

Запуск: `pnpm --filter @carbone-reports/api test:int -- test/auth.int.test.ts`.
Expected: новые тесты падают: 401 не наступает, у `logout-all` и `revoke` статус 404.

- [ ] **Step 3: sv в сессии**

`apps/api/src/modules/auth/session.ts`:
```ts
export interface SessionClaims extends SessionUser {
  sv: number;
}

export function signSession(user: SessionUser, sv: number, secret: Uint8Array): Promise<string> {
  return new SignJWT({ login: user.login, role: user.role, sv })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(user.id)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(secret);
}

export async function verifySession(
  token: string,
  secret: Uint8Array,
): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret, { algorithms: ['HS256'] });
    const role = Role.safeParse(payload.role);
    if (!payload.sub || typeof payload.login !== 'string' || !role.success) return null;
    // Cookie, выпущенные до появления отзыва сессий, не содержат sv и недействительны.
    if (!Number.isInteger(payload.sv)) return null;
    return { id: payload.sub, login: payload.login, role: role.data, sv: payload.sv as number };
  } catch {
    return null;
  }
}
```
Если у `session.ts` есть модульные тесты, обновите их под новую сигнатуру и добавьте случай «токен без sv → null».

`apps/api/src/modules/auth/guards.ts`, в `requireUser` заменить проверку строки:
```ts
    if (!row || row.blocked || row.sessionVersion !== session.sv) throw unauthorized();
```
и поправить комментарий: «Роль, блокировка и версия сессий берутся из БД: изменения применяются сразу».

- [ ] **Step 4: Cookie и logout-all**

`apps/api/src/modules/auth/routes.ts`: вынести установку cookie в экспортируемую функцию и добавить маршрут.
```ts
export async function setSessionCookie(
  reply: FastifyReply,
  deps: AppDeps,
  user: SessionUser,
  sv: number,
): Promise<void> {
  reply.setCookie(SESSION_COOKIE, await signSession(user, sv, deps.config.appSecret), {
    httpOnly: true,
    sameSite: 'lax',
    secure: deps.config.cookieSecure,
    path: '/',
    maxAge: SESSION_TTL_SECONDS,
  });
}
```
В `login` вместо прямого `reply.setCookie(...)`: `await setSessionCookie(reply, deps, user, row.sessionVersion);`.

Новый маршрут (рядом с logout):
```ts
  app.post('/api/auth/logout-all', { preHandler: guards.requireUser }, async (req, reply) => {
    await deps.db
      .update(users)
      .set({ sessionVersion: sql`${users.sessionVersion} + 1` })
      .where(eq(users.id, currentUser(req).id));
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.status(204).send();
  });
```
Импорты: `sql` из `drizzle-orm`, `FastifyReply` из `fastify`, `SessionUser` из `./session`.

- [ ] **Step 5: PATCH и revoke в users**

`apps/api/src/modules/users/routes.ts`, в `PATCH /api/users/:id`, после сборки `patch` и проверки «нет изменений»:
```ts
      // Смена пароля, роли или блокировка завершает все выданные сессии пользователя.
      const revoke = password !== undefined || role !== undefined || blocked !== undefined;
      const [row] = await deps.db
        .update(users)
        .set(revoke ? { ...patch, sessionVersion: sql`${users.sessionVersion} + 1` } : patch)
        .where(eq(users.id, req.params.id))
        .returning();
      if (!row) throw notFound('пользователь');
      // Своя запись: текущая вкладка продолжает работать с новой cookie.
      if (revoke && row.id === me.id) {
        await setSessionCookie(reply, deps, { id: row.id, login: row.login, role: row.role }, row.sessionVersion);
      }
      return toUserDto(row);
```
Обработчику нужен `reply`: `async (req, reply) => {...}`. Импорты: `sql` из `drizzle-orm`, `setSessionCookie` из `../auth/routes`.

Новый маршрут после `PATCH`:
```ts
  app.post(
    '/api/users/:id/sessions/revoke',
    { ...pre, schema: { params: IdParams } },
    async (req, reply) => {
      if (req.params.id === currentUser(req).id) {
        throw badRequest('нельзя завершить собственные сессии — используйте «Выйти везде»');
      }
      const [row] = await deps.db
        .update(users)
        .set({ sessionVersion: sql`${users.sessionVersion} + 1` })
        .where(eq(users.id, req.params.id))
        .returning({ id: users.id });
      if (!row) throw notFound('пользователь');
      return reply.status(204).send();
    },
  );
```

- [ ] **Step 6: Прогон тестов**

```bash
pnpm --filter @carbone-reports/api test
pnpm --filter @carbone-reports/api test:int
```
Expected: всё зелёное, включая новые тесты из Step 2 и прежние тесты входа и блокировки.

- [ ] **Step 7: Гейты и коммит**

```bash
pnpm typecheck && pnpm lint && pnpm exec prettier --check . && pnpm test
git add apps/api
git commit -m "feat(api): session revocation via session_version"
```

---

### Task 2: Отзыв сессий в интерфейсе

**Files:**
- Modify: `apps/web/src/api/endpoints.ts`, `apps/web/src/pages/admin/UsersPage.tsx`, `apps/web/src/app/Layout.tsx`
- Test: `apps/web/src/pages/admin/UsersPage.test.tsx`, `apps/web/src/app/auth.test.tsx`

**Interfaces:**
- Consumes (Task 1): `POST /api/users/:id/sessions/revoke` → 204; `POST /api/auth/logout-all` → 204.
- Produces:
  - `api.users.revokeSessions(id: string): Promise<void>`;
  - `api.logoutAll(): Promise<void>`;
  - кнопка с `aria-label="Завершить сессии"` в строке пользователя (кроме своей);
  - пункт подвала «Выйти везде».

- [ ] **Step 1: Endpoints**

`apps/web/src/api/endpoints.ts`:
```ts
  logoutAll: () => apiJson<void>('/api/auth/logout-all', post()),
```
и в `users`:
```ts
    revokeSessions: (id: string) => apiJson<void>(`/api/users/${id}/sessions/revoke`, post()),
```

- [ ] **Step 2: Падающие тесты**

В `apps/web/src/pages/admin/UsersPage.test.tsx` (в файле уже есть `users` и хелпер `row(login)`):
```tsx
  it('«Завершить сессии»: подтверждение, вызов API, уведомление; у себя кнопки нет', async () => {
    const { calls } = mockApi([
      adminMe,
      { path: '/api/users', body: users },
      { method: 'POST', path: '/api/users/u2/sessions/revoke', status: 204 },
    ]);
    renderRoute('/admin/users');
    await screen.findByText('ivanov');
    expect(
      within(row('admin (вы)')).queryByRole('button', { name: 'Завершить сессии' }),
    ).not.toBeInTheDocument();
    await userEvent.click(within(row('ivanov')).getByRole('button', { name: 'Завершить сессии' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Пользователю ivanov придётся войти заново на всех устройствах.');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Завершить' }));
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === 'POST' && c.path === '/api/users/u2/sessions/revoke'),
      ).toBe(true),
    );
    expect(await screen.findByText('Сессии пользователя ivanov завершены')).toBeInTheDocument();
  });
```

В `apps/web/src/app/auth.test.tsx`, рядом с тестами кнопки «Выйти» (`userMe`, `renderRoute`, `mockApi` там уже импортированы):
```tsx
  it('«Выйти везде» вызывает logout-all, очищает кэш и уводит на /login', async () => {
    const { calls } = mockApi([
      userMe,
      { method: 'POST', path: '/api/auth/logout-all', status: 204 },
      { path: '/api/templates', body: [] },
    ]);
    const { router, queryClient } = renderRoute('/reports');
    await userEvent.click(await screen.findByText('Выйти везде'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(calls.some((c) => c.method === 'POST' && c.path === '/api/auth/logout-all')).toBe(true);
    expect(queryClient.getQueryData(meKey)).toBeNull();
  });
```

Запуск: `pnpm --filter @carbone-reports/web test`. Expected: новые тесты падают.

- [ ] **Step 3: Кнопка в таблице пользователей**

`UsersPage.tsx`:
- состояние `const [revoking, setRevoking] = useState<UserDto | null>(null);`;
- мутация:
```tsx
  const revoke = useMutation({
    mutationFn: (u: UserDto) => api.users.revokeSessions(u.id),
    onSuccess: (_d, u) => {
      setRevoking(null);
      add({
        name: `users-revoked-${u.id}`,
        title: `Сессии пользователя ${u.login} завершены`,
        theme: 'success',
      });
    },
    onError: fail,
  });
```
(`add` — тот же `toaster.add`, что используется в `fail`.)
- кнопка в блоке действий, перед кнопкой блокировки, только для `!self`:
```tsx
            {!self && (
              <Button
                view="flat"
                size="s"
                aria-label="Завершить сессии"
                title="Завершить сессии"
                onClick={() => setRevoking(u)}
              >
                <Icon data={ArrowRightFromSquare} />
              </Button>
            )}
```
(иконка из `@gravity-ui/icons`).
- подтверждение (компонент `ConfirmDialog`, пропсы как у существующего диалога удаления):
```tsx
      <ConfirmDialog
        open={!!revoking}
        title="Завершить сессии"
        text={`Пользователю ${revoking?.login ?? ''} придётся войти заново на всех устройствах.`}
        confirmText="Завершить"
        loading={revoke.isPending}
        onConfirm={() => revoking && revoke.mutate(revoking)}
        onClose={() => setRevoking(null)}
      />
```
Имена пропсов возьмите из `apps/web/src/components/ConfirmDialog.tsx`.

- [ ] **Step 4: «Выйти везде» в Layout**

`Layout.tsx`: обобщить `logout`, чтобы он принимал функцию выхода:
```tsx
  const signOut = async (call: () => Promise<void>) => {
    let failed = false;
    await call().catch(() => {
      failed = true;
    });
    // ...остальное тело прежнего logout без изменений
  };
```
Подвал: прежний пункт `Выйти` вызывает `signOut(api.logout)`, а после него добавляется
```tsx
          <FooterItem
            id="logout-all"
            title="Выйти везде"
            icon={ArrowRightToSquare}
            compact={isCompact}
            onItemClick={() => void signOut(api.logoutAll)}
          />
```
Иконку подберите из `@gravity-ui/icons` так, чтобы она отличалась от «Выйти». Если в compact-режиме подвала два пункта выхода подряд путают, допустимо поставить «Выйти везде» перед «Выйти». Главное, чтобы оба были доступны.

- [ ] **Step 5: Тесты, гейты, коммит**

```bash
pnpm --filter @carbone-reports/web test
pnpm typecheck && pnpm lint && pnpm exec prettier --check . && pnpm test
git add apps/web
git commit -m "feat(web): revoke user sessions and sign out everywhere"
```

---

### Task 3: Режимы SSL источников в API

**Files:**
- Modify:
  - `packages/shared/src/index.ts`
  - `apps/api/src/db/schema.ts`
  - `apps/api/src/modules/datasources/pools.ts`
  - `apps/api/src/modules/datasources/routes.ts`
  - тесты и скрипты, которые передают `ssl: false`: `apps/api/test/*.int.test.ts`, `apps/api/test/executor.int.test.ts`, `scripts/demo-seed.ts`, `scripts/smoke.ts`
- Create: миграция `apps/api/drizzle/0002_ssl_mode.sql` (генерируется, затем правится вручную)
- Test:
  - `apps/api/src/modules/datasources/pools.test.ts` (создать или дополнить);
  - `apps/api/test/datasources.int.test.ts`;
  - `apps/api/test/ssl.int.test.ts` (новый).

**Interfaces:**
- Produces (shared):
  - `SslMode = z.enum(['disable', 'require', 'verify'])`;
  - `DatasourceBody` получает `sslMode: SslMode.default('disable')` и `sslCa: z.string().trim().nullable().default(null)`; поле `ssl` удаляется;
  - `DatasourceDto` наследует оба поля (через `omit({ password })`).
  - Правило проверки: если `sslCa` не `null` и не пустое, режим обязан быть `verify`, а текст обязан содержать `-----BEGIN CERTIFICATE-----`. Иначе `VALIDATION` с путём `sslCa`, сообщения: «CA-сертификат указывается только для режима «SSL с проверкой»» и «ожидается сертификат в формате PEM».
- Produces (api):
  - `ConnParams.ssl` заменяется на `sslMode: SslMode` и `sslCa: string | null`;
  - `sslOptions(mode, ca): pg.PoolConfig['ssl']`.
  - `testConnection` при ошибке сертификата возвращает `message` с префиксом «сертификат не прошёл проверку: ». Ошибки сертификата узнаются по коду: `SELF_SIGNED_CERT_IN_CHAIN`, `DEPTH_ZERO_SELF_SIGNED_CERT`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `ERR_TLS_CERT_ALTNAME_INVALID`, `CERT_HAS_EXPIRED`, `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`.

- [ ] **Step 1: Shared**

`packages/shared/src/index.ts`, вместо `ssl: z.boolean(),` в `DatasourceBody`:
```ts
export const SslMode = z.enum(['disable', 'require', 'verify']);
export type SslMode = z.infer<typeof SslMode>;

const PEM_CERT = '-----BEGIN CERTIFICATE-----';

export const DatasourceBody = z
  .object({
    name: z.string().trim().min(1),
    host: z.string().trim().min(1),
    port: z.number().int().min(1).max(65535),
    database: z.string().trim().min(1),
    username: z.string().trim().min(1),
    /** При обновлении: undefined — пароль не меняется. */
    password: z.string().optional(),
    sslMode: SslMode.default('disable'),
    /** CA-сертификат (PEM) для режима verify; null — системные корневые сертификаты. */
    sslCa: z
      .string()
      .trim()
      .nullable()
      .default(null)
      .transform((v) => (v ? v : null)),
  })
  .superRefine((d, ctx) => {
    if (d.sslCa === null) return;
    if (d.sslMode !== 'verify') {
      ctx.addIssue({
        code: 'custom',
        path: ['sslCa'],
        message: 'CA-сертификат указывается только для режима «SSL с проверкой»',
      });
    } else if (!d.sslCa.includes(PEM_CERT)) {
      ctx.addIssue({ code: 'custom', path: ['sslCa'], message: 'ожидается сертификат в формате PEM' });
    }
  });
```
`DatasourceDto` сейчас строится через `DatasourceBody.omit(...)`, а у объекта с `superRefine` метода `omit` нет. Поэтому сначала объявите `const DatasourceFields = z.object({...})`, затем `DatasourceBody = DatasourceFields.superRefine(...)` и `DatasourceDto = DatasourceFields.omit({ password: true }).extend({...})`. В DTO `sslCa` — `string | null`.

Модульные тесты в `packages/shared/src/index.test.ts`:
```ts
describe('DatasourceBody: SSL', () => {
  const base = { name: 'n', host: 'h', port: 5432, database: 'd', username: 'u' };
  it('по умолчанию disable и без CA', () => {
    const r = DatasourceBody.parse(base);
    expect(r.sslMode).toBe('disable');
    expect(r.sslCa).toBeNull();
  });
  it('CA без режима verify — ошибка у поля sslCa', () => {
    const r = DatasourceBody.safeParse({ ...base, sslMode: 'require', sslCa: '-----BEGIN CERTIFICATE-----x' });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0]!.path).toEqual(['sslCa']);
  });
  it('verify с не-PEM — ошибка', () => {
    expect(DatasourceBody.safeParse({ ...base, sslMode: 'verify', sslCa: 'abc' }).success).toBe(false);
  });
  it('verify с PEM и verify без CA — ок; пустая строка CA = null', () => {
    expect(DatasourceBody.parse({ ...base, sslMode: 'verify', sslCa: '-----BEGIN CERTIFICATE-----\nAA\n-----END CERTIFICATE-----' }).sslCa).toContain('BEGIN');
    expect(DatasourceBody.parse({ ...base, sslMode: 'verify', sslCa: '  ' }).sslCa).toBeNull();
  });
});
```

- [ ] **Step 2: Схема и миграция с переносом данных**

`schema.ts`, `datasources`: вместо `ssl: boolean(...)`:
```ts
  sslMode: text('ssl_mode').$type<SslMode>().notNull().default('disable'),
  sslCa: text('ssl_ca'),
```
(`SslMode` импортировать из `@carbone-reports/shared`.)

```bash
pnpm --filter @carbone-reports/api db:generate --name ssl_mode
```
drizzle-kit может спросить, переименовать ли колонку `ssl`. Выбирайте **create column** (новая колонка), а не rename. Сгенерированный SQL исправьте вручную, чтобы порядок был такой: добавить колонки, перенести данные, удалить старую.
```sql
ALTER TABLE "datasources" ADD COLUMN "ssl_mode" text DEFAULT 'disable' NOT NULL;--> statement-breakpoint
ALTER TABLE "datasources" ADD COLUMN "ssl_ca" text;--> statement-breakpoint
UPDATE "datasources" SET "ssl_mode" = CASE WHEN "ssl" THEN 'require' ELSE 'disable' END;--> statement-breakpoint
ALTER TABLE "datasources" DROP COLUMN "ssl";
```
Если генератор запрашивает ответ интерактивно, а терминал этого не позволяет, создайте файл миграции через `db:generate --custom --name ssl_mode`. Тогда SQL пишется вручную, а `meta/_journal.json` и snapshot генератор обновит сам. Проверьте, что snapshot `0002` соответствует новой схеме: повторный `db:generate` должен сказать «No schema changes».

- [ ] **Step 3: Падающие тесты пулов**

`apps/api/src/modules/datasources/pools.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { certErrorMessage, sslOptions } from './pools';

describe('sslOptions', () => {
  it('disable → false', () => expect(sslOptions('disable', null)).toBe(false));
  it('require → без проверки', () =>
    expect(sslOptions('require', null)).toEqual({ rejectUnauthorized: false }));
  it('verify без CA → проверка по системным корням', () =>
    expect(sslOptions('verify', null)).toEqual({ rejectUnauthorized: true }));
  it('verify с CA → ca передаётся', () =>
    expect(sslOptions('verify', 'PEM')).toEqual({ rejectUnauthorized: true, ca: 'PEM' }));
});

describe('certErrorMessage', () => {
  it('ошибка сертификата получает понятный префикс', () => {
    const e = Object.assign(new Error('self-signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' });
    expect(certErrorMessage(e)).toBe('сертификат не прошёл проверку: self-signed certificate');
  });
  it('прочие ошибки — как есть', () => {
    expect(certErrorMessage(new Error('connection refused'))).toBe('connection refused');
  });
});
```

- [ ] **Step 4: Реализация пулов**

`pools.ts`:
```ts
export interface ConnParams {
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  sslMode: SslMode;
  sslCa: string | null;
}

export function sslOptions(mode: SslMode, ca: string | null): pg.PoolConfig['ssl'] {
  if (mode === 'disable') return false;
  // require: шифрование без проверки (источники во внутренней сети с самоподписанными сертификатами).
  if (mode === 'require') return { rejectUnauthorized: false };
  return ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true };
}

const CERT_ERRORS = new Set([
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED',
]);

export function certErrorMessage(e: Error): string {
  const code = (e as NodeJS.ErrnoException).code;
  return code && CERT_ERRORS.has(code) ? `сертификат не прошёл проверку: ${e.message}` : e.message;
}
```
В `poolConfig`: `ssl: sslOptions(c.sslMode, c.sslCa),`. Старый комментарий про самоподписанные сертификаты удалить: он переехал в `sslOptions`.

В `connParamsFromRow`: `sslMode: row.sslMode, sslCa: row.sslCa,`.

В `testConnection`: `return { ok: false, message: certErrorMessage(e as Error) };`.

`routes.ts`, `toDatasourceDto`: `sslMode: r.sslMode, sslCa: r.sslCa,` вместо `ssl`. `PATCH` по-прежнему вызывает `deps.sources.invalidate(row.id)`, поэтому смена режима пересоздаёт пул. Проверьте, что `POST /api/datasources/test` собирает `ConnParams` из тела с новыми полями. Если там есть явный маппинг, добавьте в него `sslMode` и `sslCa`.

- [ ] **Step 5: Обновить вызовы `ssl: false`**

```bash
grep -rn "ssl: false\|ssl: true\|\.ssl\b" apps/api scripts e2e demo --include=*.ts
```
- В интеграционных тестах и скриптах удалить `ssl: false` из payload: по умолчанию и так `disable`.
- В `executor.int.test.ts` в `poolConfig({...})` передать `sslMode: 'disable', sslCa: null`.
- В `scripts/demo-seed.ts` заменить `ssl: false` на `sslMode: 'disable'`.

- [ ] **Step 6: Интеграционные тесты SSL**

`apps/api/test/ssl.int.test.ts`. Тест поднимает отдельный Postgres с SSL и сертификатом на `localhost`, который генерируется внутри контейнера (в debian-образе `postgres` есть `openssl`):
```ts
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testConnection } from '../src/modules/datasources/pools';

let pg: StartedTestContainer;
let ca: string;
const PASSWORD = 'ssl-test-password';

beforeAll(async () => {
  pg = await new GenericContainer('postgres:17')
    .withEnvironment({ POSTGRES_PASSWORD: PASSWORD })
    .withExposedPorts(5432)
    .withEntrypoint(['bash', '-c'])
    .withCommand([
      [
        'set -e',
        'mkdir -p /certs',
        'openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj "/CN=localhost" ' +
          '-addext "subjectAltName=DNS:localhost,IP:127.0.0.1" ' +
          '-keyout /certs/server.key -out /certs/server.crt',
        'chown postgres:postgres /certs/server.key /certs/server.crt',
        'chmod 600 /certs/server.key',
        'exec docker-entrypoint.sh postgres -c ssl=on -c ssl_cert_file=/certs/server.crt -c ssl_key_file=/certs/server.key',
      ].join(' && '),
    ])
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .start();
  ca = (await pg.exec(['cat', '/certs/server.crt'])).output;
}, 120_000);
afterAll(() => pg?.stop());

const conn = (sslMode: 'disable' | 'require' | 'verify', sslCa: string | null, host = 'localhost') => ({
  host,
  port: pg.getMappedPort(5432),
  database: 'postgres',
  username: 'postgres',
  password: PASSWORD,
  sslMode,
  sslCa,
});

describe('SSL источников', () => {
  it('require подключается к серверу с самоподписанным сертификатом', async () => {
    expect(await testConnection(conn('require', null))).toEqual({ ok: true });
  });
  it('verify без CA отклоняет самоподписанный сертификат с понятной ошибкой', async () => {
    const r = await testConnection(conn('verify', null));
    expect(r.ok).toBe(false);
    expect((r as { message: string }).message).toMatch(/^сертификат не прошёл проверку: /);
  });
  it('verify с CA подключается', async () => {
    expect(await testConnection(conn('verify', ca))).toEqual({ ok: true });
  });
  it('verify с CA, но чужим именем хоста — ошибка проверки', async () => {
    const r = await testConnection(conn('verify', ca, '127.0.0.2'));
    expect(r.ok).toBe(false);
  });
});
```
- Тест с чужим именем хоста зависит от того, как маршрутизируется `127.0.0.2`. Если в этом окружении он не подключается вообще, по другой причине, замените хост на IP хоста Docker, которого нет в SAN. Можно и убрать этот тест, если в отчёте будет объяснено почему. Главная проверка — первые три теста.
- Если `pg.exec` возвращает вывод с лишними символами, обрежьте его по `-----END CERTIFICATE-----`.

В `apps/api/test/datasources.int.test.ts` добавить:
```ts
it('sslMode и sslCa сохраняются и возвращаются; CA без verify → 400 с полем sslCa', async () => {
  const pem = '-----BEGIN CERTIFICATE-----\nAA\n-----END CERTIFICATE-----';
  const ok = await t.app.inject({ method: 'POST', url: '/api/datasources', headers: { cookie: admin },
    payload: { ...body(), sslMode: 'verify', sslCa: pem } });
  expect(ok.statusCode).toBe(201);
  expect(ok.json()).toMatchObject({ sslMode: 'verify', sslCa: pem });
  const bad = await t.app.inject({ method: 'POST', url: '/api/datasources', headers: { cookie: admin },
    payload: { ...body(), sslMode: 'require', sslCa: pem } });
  expect(bad.statusCode).toBe(400);
  expect(JSON.stringify(bad.json())).toContain('sslCa');
});

```

Тест SQL миграции (Review Focus 2) — новый файл `apps/api/test/ssl-migration.int.test.ts`:
```ts
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';
import { expect, it } from 'vitest';
import { createTestDatabase } from './helpers';

it('миграция ssl → ssl_mode: true → require, false → disable', async () => {
  const client = new pg.Client({ connectionString: await createTestDatabase() });
  await client.connect();
  try {
    // Таблица в форме до миграции (только колонки, которые затрагивает 0002).
    await client.query(`create table datasources (id serial primary key, ssl boolean not null default false)`);
    await client.query(`insert into datasources (ssl) values (true), (false)`);
    const dir = join(import.meta.dirname, '../drizzle');
    const file = (await readdir(dir)).find((f) => f.startsWith('0002_'))!;
    const sqlText = await readFile(join(dir, file), 'utf8');
    for (const stmt of sqlText.split('--> statement-breakpoint')) {
      if (stmt.trim()) await client.query(stmt);
    }
    const { rows } = await client.query(`select id, ssl_mode, ssl_ca from datasources order by id`);
    expect(rows).toEqual([
      { id: 1, ssl_mode: 'require', ssl_ca: null },
      { id: 2, ssl_mode: 'disable', ssl_ca: null },
    ]);
  } finally {
    await client.end();
  }
});
```
Если `0002` содержит операции над другими таблицами, создайте в тесте и их минимальные версии. Лучше, однако, чтобы `0002` касалась только `datasources`.

- [ ] **Step 7: Прогон, гейты, коммит**

```bash
pnpm --filter @carbone-reports/shared test
pnpm --filter @carbone-reports/api test
pnpm --filter @carbone-reports/api test:int
pnpm typecheck && pnpm lint && pnpm exec prettier --check . && pnpm test
git add packages/shared apps/api scripts
git commit -m "feat(api): datasource SSL modes with custom CA"
```
`pnpm typecheck` может упасть в `apps/web`, потому что фронт ещё использует `ssl`. В этой задаче поправьте только типы фронта минимально: `ssl` → `sslMode` в `DatasourceDialog` (временно через чекбокс: `sslMode: checked ? 'require' : 'disable'`), в `DatasourcesPage` и в тестовых фикстурах (`ssl: false` → `sslMode: 'disable', sslCa: null`). Полноценная форма делается в Task 4.

---

### Task 4: Режимы SSL в форме источника

**Files:**
- Modify: `apps/web/src/pages/admin/DatasourceDialog.tsx`, `apps/web/src/pages/admin/DatasourcesPage.tsx`
- Test: `apps/web/src/pages/admin/DatasourcesPage.test.tsx`

**Interfaces:**
- Consumes (Task 3): `DatasourceBody.sslMode: 'disable'|'require'|'verify'`, `sslCa: string|null`; DTO с теми же полями; ошибка `VALIDATION` с путём `sslCa`.

- [ ] **Step 1: Падающие тесты**

В `apps/web/src/pages/admin/DatasourcesPage.test.tsx`: в фикстуре `ds` заменить `ssl: false` на `sslMode: 'disable', sslCa: null`. В ожиданиях тела запроса существующих тестов `ssl: false` заменить на `sslMode: 'disable', sslCa: null`. Затем добавить хелпер и тесты:
```tsx
async function openCreate() {
  renderRoute('/admin/datasources');
  await userEvent.click(await screen.findByRole('button', { name: 'Добавить источник' }));
  const dialog = await screen.findByRole('dialog');
  await userEvent.type(within(dialog).getByLabelText('Название'), 'Склад');
  await userEvent.type(within(dialog).getByLabelText('Хост'), 'db');
  await userEvent.type(within(dialog).getByLabelText('База данных'), 'wh');
  await userEvent.type(within(dialog).getByLabelText('Пользователь БД'), 'ro');
  await userEvent.type(within(dialog).getByLabelText('Пароль'), 'secret');
  return dialog;
}
const PEM = '-----BEGIN CERTIFICATE-----';

  it('режим «SSL с проверкой» показывает поле CA и отправляет sslMode/sslCa', async () => {
    const { calls } = mockApi([
      adminMe,
      { path: '/api/datasources', body: [] },
      { method: 'POST', path: '/api/datasources', status: 201, body: ds },
    ]);
    const dialog = await openCreate();
    expect(within(dialog).queryByLabelText('CA-сертификат (PEM)')).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('radio', { name: 'SSL с проверкой сертификата' }));
    await userEvent.type(within(dialog).getByLabelText('CA-сертификат (PEM)'), PEM);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST' && c.path === '/api/datasources')?.body).toMatchObject({
        sslMode: 'verify',
        sslCa: PEM,
      }),
    );
  });

  it('при смене режима с verify поле CA скрывается и не отправляется', async () => {
    const { calls } = mockApi([
      adminMe,
      { path: '/api/datasources', body: [] },
      { method: 'POST', path: '/api/datasources', status: 201, body: ds },
    ]);
    const dialog = await openCreate();
    await userEvent.click(within(dialog).getByRole('radio', { name: 'SSL с проверкой сертификата' }));
    await userEvent.type(within(dialog).getByLabelText('CA-сертификат (PEM)'), PEM);
    await userEvent.click(within(dialog).getByRole('radio', { name: 'SSL без проверки сертификата' }));
    expect(within(dialog).queryByLabelText('CA-сертификат (PEM)')).not.toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST' && c.path === '/api/datasources')?.body).toMatchObject({
        sslMode: 'require',
        sslCa: null,
      }),
    );
  });

  it('ошибка сервера по sslCa показывается у поля CA', async () => {
    mockApi([
      adminMe,
      { path: '/api/datasources', body: [] },
      {
        method: 'POST',
        path: '/api/datasources',
        status: 400,
        body: {
          error: {
            code: 'VALIDATION',
            message: 'bad',
            details: [{ path: '/sslCa', message: 'ожидается сертификат в формате PEM' }],
          },
        },
      },
    ]);
    const dialog = await openCreate();
    await userEvent.click(within(dialog).getByRole('radio', { name: 'SSL с проверкой сертификата' }));
    await userEvent.type(within(dialog).getByLabelText('CA-сертификат (PEM)'), 'abc');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Сохранить' }));
    expect(await within(dialog).findByText('ожидается сертификат в формате PEM')).toBeInTheDocument();
  });

  it('источник с require: метка «SSL» в списке и выбранный режим в диалоге', async () => {
    mockApi([adminMe, { path: '/api/datasources', body: [{ ...ds, sslMode: 'require' }] }]);
    renderRoute('/admin/datasources');
    const cell = (await screen.findByText('Склад')).closest('tr')!;
    expect(within(cell).getByText('SSL')).toBeInTheDocument();
    await userEvent.click(within(cell).getByRole('button', { name: 'Изменить' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('radio', { name: 'SSL без проверки сертификата' })).toBeChecked();
  });
```
Формат `details` (`/sslCa` или `sslCa`) возьмите таким же, как в существующем тесте VALIDATION этого файла: `fieldErrors()` поддерживает обе формы. Кнопку открытия диалога редактирования проверьте в `DatasourcesPage.tsx` (aria-label может быть «Изменить» или другой).

- [ ] **Step 2: Форма**

`DatasourceDialog.tsx`:
- В состоянии вместо `ssl` — `sslMode: datasource?.sslMode ?? 'disable'` и `sslCa: datasource?.sslCa ?? ''`.
- `body()` отправляет `sslMode`, а `sslCa` только при `verify`: `sslCa: form.sslMode === 'verify' && form.sslCa.trim() ? form.sslCa : null`.
- `connDirty` учитывает `sslMode` и `sslCa`.
- Вместо `Checkbox` — `RadioGroup` из `@gravity-ui/uikit`:
```tsx
          <Field label="SSL" error={errors.sslMode}>
            <RadioGroup
              direction="vertical"
              value={form.sslMode}
              onUpdate={(v) => set('sslMode', v as SslMode)}
              options={[
                { value: 'disable', content: 'Без SSL' },
                { value: 'require', content: 'SSL без проверки сертификата' },
                { value: 'verify', content: 'SSL с проверкой сертификата' },
              ]}
            />
          </Field>
          {form.sslMode === 'verify' && (
            <Field
              label="CA-сертификат (PEM)"
              error={errors.sslCa}
              hint="Пусто — проверка по системным корневым сертификатам"
            >
              <TextArea
                value={form.sslCa}
                onUpdate={(v) => set('sslCa', v)}
                minRows={4}
                placeholder="-----BEGIN CERTIFICATE-----"
                validationState={errors.sslCa ? 'invalid' : undefined}
                controlProps={{ 'aria-label': 'CA-сертификат (PEM)' }}
              />
            </Field>
          )}
```
- Если у `Field` нет пропа `hint`, выведите подсказку отдельной строкой `<Text color="secondary">`.
- В `GeneralError` добавьте `'sslMode', 'sslCa'` в `shown`.

`DatasourcesPage.tsx`, колонка SSL:
```tsx
    {
      id: 'ssl',
      name: 'SSL',
      template: (d) =>
        d.sslMode === 'disable' ? '—' : (
          <Label theme={d.sslMode === 'verify' ? 'success' : 'info'}>
            {d.sslMode === 'verify' ? 'SSL, проверка' : 'SSL'}
          </Label>
        ),
    },
```
Уберите временную логику чекбокса из Task 3, если она осталась.

- [ ] **Step 3: Тесты, гейты, коммит**

```bash
pnpm --filter @carbone-reports/web test
pnpm typecheck && pnpm lint && pnpm exec prettier --check . && pnpm test
git add apps/web
git commit -m "feat(web): datasource SSL mode selector with CA certificate"
```

---

### Task 5: Срок жизни callback-токена OnlyOffice

**Files:**
- Modify: `apps/api/src/modules/onlyoffice/jwt.ts`, `apps/api/src/modules/onlyoffice/callback.ts`
- Test: `apps/api/test/onlyoffice.int.test.ts`, `apps/api/src/modules/onlyoffice/jwt.test.ts` (создать)

**Interfaces:**
- Produces:
  - `verifyOnlyOfficeCallback(token, secret, now?: number): Promise<Record<string, unknown>>` проверяет подпись и требует `exp` с допуском 60 с. Если `exp` нет, принимает `iat` не старше `CALLBACK_MAX_AGE_SECONDS = 600`. Если нет ни `exp`, ни `iat`, бросает ошибку.
  - `signOnlyOffice(payload, secret, opts?: { expiresIn?: string })`: если указан `expiresIn`, добавляет `iat` и `exp`. Конфиг редактора по-прежнему подписывается без срока.
  - Поведение callback: просроченный токен или токен без срока → 403 `FORBIDDEN` «неверная подпись OnlyOffice». Document Server считает любой ответ, кроме `{"error":0}`, неуспешным и повторяет запрос.

- [ ] **Step 1: Что присылает реальный Document Server**

Поднимите стек (`pnpm stack:demo`) и проверьте, что Document Server кладёт в исходящие токены:
```bash
docker compose exec onlyoffice sh -c 'cat /etc/onlyoffice/documentserver/local.json; grep -n "outbox" -A6 /etc/onlyoffice/documentserver/default.json'
```
Expected: в `services.CoAuthoring.token.outbox` есть `expires` (по умолчанию `"5m"`), значит в callback приходят `iat` и `exp`. Запишите фактическое значение в отчёт.

Дополнительно можно снять реальный callback: временно добавьте в `handleCallback` лог декодированного заголовка токена (`jose.decodeJwt`, только claims `iat`/`exp`), откройте шаблон в редакторе, сохраните его и найдите запись в `docker compose logs api`. **Лог перед коммитом удалить.** Если `exp` действительно приходит, основной путь — `exp`, а ветка с `iat` остаётся страховкой.

- [ ] **Step 2: Падающие тесты**

`apps/api/src/modules/onlyoffice/jwt.test.ts`:
```ts
import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { CALLBACK_MAX_AGE_SECONDS, verifyOnlyOfficeCallback } from './jwt';

const secret = new TextEncoder().encode('s'.repeat(40));
const now = Math.floor(Date.now() / 1000);
const sign = (claims: Record<string, unknown>) =>
  new SignJWT(claims).setProtectedHeader({ alg: 'HS256' }).sign(secret);

describe('verifyOnlyOfficeCallback', () => {
  it('принимает свежий токен с exp', async () => {
    await expect(verifyOnlyOfficeCallback(await sign({ key: 'k', exp: now + 300 }), secret)).resolves.toMatchObject({ key: 'k' });
  });
  it('отклоняет просроченный exp (за пределами допуска 60 с)', async () => {
    await expect(verifyOnlyOfficeCallback(await sign({ exp: now - 120 }), secret)).rejects.toThrow();
  });
  it('допуск 60 с на расхождение часов', async () => {
    await expect(verifyOnlyOfficeCallback(await sign({ exp: now - 30 }), secret)).resolves.toBeTruthy();
  });
  it('без exp: свежий iat — ок, старый — отказ', async () => {
    await expect(verifyOnlyOfficeCallback(await sign({ iat: now - 60 }), secret)).resolves.toBeTruthy();
    await expect(verifyOnlyOfficeCallback(await sign({ iat: now - CALLBACK_MAX_AGE_SECONDS - 120 }), secret)).rejects.toThrow();
  });
  it('без exp и iat — отказ', async () => {
    await expect(verifyOnlyOfficeCallback(await sign({ key: 'k' }), secret)).rejects.toThrow();
  });
  it('чужой секрет — отказ', async () => {
    const other = await new SignJWT({ exp: now + 60 }).setProtectedHeader({ alg: 'HS256' }).sign(new TextEncoder().encode('x'.repeat(40)));
    await expect(verifyOnlyOfficeCallback(other, secret)).rejects.toThrow();
  });
});
```

В `apps/api/test/onlyoffice.int.test.ts`:
- Хелпер `callback(...)` подписывает с `{ expiresIn: '5m' }`: `signOnlyOffice(body, secret(), { expiresIn: '5m' })`, для варианта с заголовком так же. Все существующие тесты должны остаться зелёными.
- Новые тесты:
```ts
describe('срок жизни callback-токена', () => {
  const raw = (token: string) =>
    t.app.inject({ method: 'POST', url: `/internal/onlyoffice/callback/${tplId}`, payload: { token } });

  it('просроченный токен → 403, версия не меняется', async () => {
    const r0 = await row();
    const { SignJWT } = await import('jose');
    const token = await new SignJWT({ key: r0.docKey, status: 2, url: pub('x') })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3000)
      .sign(secret());
    expect((await raw(token)).statusCode).toBe(403);
    expect((await row()).version).toBe(r0.version);
  });

  it('токен без exp и iat → 403', async () => {
    const r0 = await row();
    const token = await signOnlyOffice({ key: r0.docKey, status: 2, url: pub('x') }, secret());
    expect((await raw(token)).statusCode).toBe(403);
  });

  it('повтор со свежим токеном после отказа сохраняет версию', async () => {
    const r0 = await row();
    const res = await callback({ key: r0.docKey, status: 2, url: pub('fresh') });
    expect(res.statusCode).toBe(200);
    expect((await row()).version).toBe(r0.version + 1);
  });

  it('чужой секрет → 403', async () => {
    const r0 = await row();
    const token = await signOnlyOffice(
      { key: r0.docKey, status: 2, url: pub('x') },
      new TextEncoder().encode('wrong-secret-'.repeat(4)),
      { expiresIn: '5m' },
    );
    expect((await raw(token)).statusCode).toBe(403);
  });

  it('статус 7 записывает lastSaveError и не меняет версию', async () => {
    const r0 = await row();
    const res = await callback({ key: r0.docKey, status: 7 });
    expect(res.statusCode).toBe(200);
    const r1 = await row();
    expect(r1.version).toBe(r0.version);
    expect(r1.lastSaveError).toBe('ошибка принудительного сохранения OnlyOffice');
  });
});
```
Если тесты на статус 7 или на чужой секрет уже есть в файле, не дублируйте их: оставьте ссылку в отчёте.

- [ ] **Step 3: Реализация**

`jwt.ts`:
```ts
export const CALLBACK_MAX_AGE_SECONDS = 600;
const CLOCK_TOLERANCE_SECONDS = 60;

export function signOnlyOffice(
  payload: Record<string, unknown>,
  secret: Uint8Array,
  opts: { expiresIn?: string } = {},
): Promise<string> {
  const jwt = new SignJWT(payload as JWTPayload).setProtectedHeader({ alg: 'HS256', typ: 'JWT' });
  if (opts.expiresIn) jwt.setIssuedAt().setExpirationTime(opts.expiresIn);
  return jwt.sign(secret);
}

/**
 * Токен входящего callback: подпись + срок жизни. Document Server ставит exp (token.outbox.expires);
 * без exp принимается только свежий iat — иначе перехваченный callback можно было бы повторить.
 */
export async function verifyOnlyOfficeCallback(
  token: string,
  secret: Uint8Array,
  now: number = Math.floor(Date.now() / 1000),
): Promise<Record<string, unknown>> {
  const { payload } = await jwtVerify(token, secret, {
    algorithms: ['HS256'],
    clockTolerance: CLOCK_TOLERANCE_SECONDS,
    currentDate: new Date(now * 1000),
  });
  if (payload.exp === undefined) {
    if (typeof payload.iat !== 'number' || now - payload.iat > CALLBACK_MAX_AGE_SECONDS) {
      throw new Error('callback-токен без срока действия');
    }
  }
  return payload as Record<string, unknown>;
}
```
`callback.ts`, `verifiedPayload`: заменить оба вызова `verifyOnlyOffice` на `verifyOnlyOfficeCallback`. Сам `verifyOnlyOffice` остаётся: его импортирует `apps/api/test/onlyoffice.int.test.ts` для проверки подписи конфигурации редактора.

- [ ] **Step 4: Прогон на живом стеке**

```bash
pnpm --filter @carbone-reports/api test && pnpm --filter @carbone-reports/api test:int
docker compose --profile demo up -d --build --no-deps --wait api
pnpm e2e
```
Expected: модульные и интеграционные тесты зелёные. E2E «OnlyOffice: правка шаблона, сохранение…» зелёный: реальный callback с `exp` проходит. Удалите висячий предыдущий образ api проекта `carbone-reports`.

- [ ] **Step 5: Гейты и коммит**

```bash
pnpm typecheck && pnpm lint && pnpm exec prettier --check . && pnpm test
git add apps/api
git commit -m "feat(api): require fresh OnlyOffice callback tokens"
```

---

### Task 6: Атомарная запись файла шаблона

**Files:**
- Create: `apps/api/src/modules/templates/file-migration.ts`, `apps/api/test/template-files.int.test.ts`
- Modify:
  - `apps/api/src/lib/storage.ts`: `remove` удаляет и каталоги;
  - `apps/api/src/modules/templates/service.ts`;
  - `apps/api/src/modules/templates/routes.ts`;
  - `apps/api/src/modules/onlyoffice/callback.ts`;
  - `apps/api/src/server.ts`;
  - `apps/api/test/onlyoffice.int.test.ts`, `apps/api/test/templates.int.test.ts` — там, где тесты опираются на старый путь.

**Interfaces:**
- Produces:
  - `templateFilePath(id: string, ext: TemplateExt, version: number): string` → `templates/${id}/v${version}.${ext}`;
  - `templateDir(id: string): string` → `templates/${id}`;
  - `migrateTemplateFiles(deps: { db: Db; storage: Storage; log?: { warn(o: unknown, msg?: string): void; info(o: unknown, msg?: string): void } }): Promise<number>` возвращает число перенесённых файлов;
  - `Storage.remove(rel)` удаляет файл или каталог рекурсивно (`rm(..., { recursive: true, force: true })`).

Правила:
- Новая версия всегда пишется в **новый** путь. `file_path` и `version` обновляются в одной транзакции. Старый файл удаляется после коммита, ошибка удаления только логируется.
- Callback сначала скачивает файл без блокировки и проверяет его (`isZip`). Затем открывает транзакцию с `FOR UPDATE`, сверяет `docKey`, пишет файл и обновляет строку.
- Удаление шаблона удаляет каталог `templates/<id>` целиком.

- [ ] **Step 1: Падающие тесты**

`apps/api/test/template-files.int.test.ts`. Хелперы — из `./helpers` (`createTestApp`, `loginAs`, `createSourceDatabase`, `createTemplate`); их сигнатуры сверьте с файлом.
```ts
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { templates } from '../src/db/schema';
import { migrateTemplateFiles } from '../src/modules/templates/file-migration';
import { createBlankDocument } from '../src/modules/templates/blank';
import { createSourceDatabase, createTemplate, createTestApp, loginAs, type TestApp } from './helpers';

let t: TestApp;
let admin: string;
let dsId: string;

beforeAll(async () => {
  t = await createTestApp();
  admin = (await loginAs(t, 'admin')).cookie;
  const src = await createSourceDatabase('select 1');
  dsId = (await t.app.inject({ method: 'POST', url: '/api/datasources', headers: { cookie: admin },
    payload: { name: 's', ...src } })).json().id;
});
afterAll(() => t.close());

const rowOf = async (id: string) => (await t.deps.db.select().from(templates).where(eq(templates.id, id)))[0]!;

async function putFile(id: string, data: Buffer) {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(data)]), 'x.docx');
  const req = new Request('http://x', { method: 'PUT', body: form });
  return t.app.inject({
    method: 'PUT', url: `/api/templates/${id}/file`,
    headers: { cookie: admin, 'content-type': req.headers.get('content-type')! },
    payload: Buffer.from(await req.arrayBuffer()),
  });
}

describe('файлы шаблонов по версиям', () => {
  it('новый шаблон хранится в templates/<id>/v1.<ext>', async () => {
    const id = await createTemplate(t, admin, dsId);
    expect((await rowOf(id)).filePath).toBe(`templates/${id}/v1.docx`);
  });

  it('PUT /file пишет новую версию в новый путь и удаляет старый файл', async () => {
    const id = await createTemplate(t, admin, dsId);
    const r = await putFile(id, await createBlankDocument('docx'));
    expect(r.statusCode).toBe(200);
    const row = await rowOf(id);
    expect(row.version).toBe(2);
    expect(row.filePath).toBe(`templates/${id}/v2.docx`);
    expect(await t.deps.storage.exists(`templates/${id}/v2.docx`)).toBe(true);
    expect(await t.deps.storage.exists(`templates/${id}/v1.docx`)).toBe(false);
  });

  it('сбой транзакции после записи файла: версия и путь прежние, старый файл на месте', async () => {
    const id = await createTemplate(t, admin, dsId);
    const before = await rowOf(id);
    // Принудительный сбой UPDATE: триггер, который бросает исключение для этой строки.
    await t.deps.db.execute(`
      create or replace function cr_fail() returns trigger as $$ begin raise exception 'boom'; end $$ language plpgsql;
      create trigger cr_fail_tr before update on templates for each row
        when (old.id = '${id}') execute function cr_fail();`);
    try {
      const r = await putFile(id, await createBlankDocument('docx'));
      expect(r.statusCode).toBe(500);
    } finally {
      await t.deps.db.execute('drop trigger cr_fail_tr on templates; drop function cr_fail();');
    }
    const after = await rowOf(id);
    expect(after.version).toBe(before.version);
    expect(after.filePath).toBe(before.filePath);
    expect(await t.deps.storage.exists(before.filePath)).toBe(true);
    // Отчёт по-прежнему собирается из прежнего файла
    expect((await t.deps.storage.read(after.filePath)).length).toBeGreaterThan(0);
  });

  it('удаление шаблона удаляет каталог со всеми версиями', async () => {
    const id = await createTemplate(t, admin, dsId);
    await t.deps.storage.write(`templates/${id}/orphan.tmp`, Buffer.from('x'));
    const r = await t.app.inject({ method: 'DELETE', url: `/api/templates/${id}`, headers: { cookie: admin } });
    expect(r.statusCode).toBe(204);
    expect(await t.deps.storage.exists(`templates/${id}/v1.docx`)).toBe(false);
    expect(await t.deps.storage.exists(`templates/${id}/orphan.tmp`)).toBe(false);
  });

  it('дублирование копирует текущую версию в templates/<новый id>/v1', async () => {
    const id = await createTemplate(t, admin, dsId);
    await putFile(id, await createBlankDocument('docx'));
    const r = await t.app.inject({ method: 'POST', url: `/api/templates/${id}/duplicate`, headers: { cookie: admin } });
    const copy = await rowOf(r.json().id);
    expect(copy.filePath).toBe(`templates/${copy.id}/v1.docx`);
    expect(await t.deps.storage.exists(copy.filePath)).toBe(true);
  });
});

describe('перенос старых путей при старте', () => {
  it('переносит templates/<id>.<ext> в templates/<id>/v<version>.<ext>, идемпотентно, без файла — не падает', async () => {
    const a = await createTemplate(t, admin, dsId);
    const b = await createTemplate(t, admin, dsId);
    const data = await t.deps.storage.read((await rowOf(a)).filePath);
    // Имитация старого формата: файл по старому пути, строка указывает на него; версия 3.
    await t.deps.storage.write(`templates/${a}.docx`, data);
    await t.deps.db.update(templates).set({ filePath: `templates/${a}.docx`, version: 3 }).where(eq(templates.id, a));
    // b: старый путь, но файла нет
    await t.deps.db.update(templates).set({ filePath: `templates/${b}.docx` }).where(eq(templates.id, b));

    expect(await migrateTemplateFiles({ db: t.deps.db, storage: t.deps.storage })).toBe(1);
    const ra = await rowOf(a);
    expect(ra.filePath).toBe(`templates/${a}/v3.docx`);
    expect(await t.deps.storage.exists(ra.filePath)).toBe(true);
    expect(await t.deps.storage.exists(`templates/${a}.docx`)).toBe(false);
    expect((await rowOf(b)).filePath).toBe(`templates/${b}.docx`); // не тронут, только предупреждение

    expect(await migrateTemplateFiles({ db: t.deps.db, storage: t.deps.storage })).toBe(0);
  });
});
```
- Сформируйте multipart-тело `putFile` так же, как существующие тесты `PUT /file` в `templates.int.test.ts`. Если там есть готовый хелпер, используйте его.
- Тест с триггером проверяет Review Focus 4. `db.execute` со строкой SQL: если drizzle требует `sql\`...\``, используйте `sql.raw`.

В `apps/api/test/onlyoffice.int.test.ts` добавить:
```ts
it('callback не держит блокировку строки во время скачивания: параллельный PATCH шаблона проходит', async () => {
  const r0 = await row();
  const saving = callback({ key: r0.docKey, status: 6, url: pub('slow') }); // fetchFile ждёт 300 мс
  await new Promise((r) => setTimeout(r, 50));
  const started = Date.now();
  const patch = await t.app.inject({
    method: 'PATCH', url: `/api/templates/${tplId}`, headers: { cookie: admin },
    payload: { description: 'параллельно' },
  });
  expect(patch.statusCode).toBe(200);
  expect(Date.now() - started).toBeLessThan(200);
  expect((await saving).statusCode).toBe(200);
  expect((await row()).version).toBe(r0.version + 1);
});

it('ключ сменился за время скачивания: файл выбрасывается, версия не растёт', async () => {
  const r0 = await row();
  const saving = callback({ key: r0.docKey, status: 2, url: pub('slow') });
  await new Promise((r) => setTimeout(r, 50));
  await t.deps.db.update(templates).set({ docKey: 'changed' }).where(eq(templates.id, tplId));
  expect((await saving).statusCode).toBe(200);
  const r1 = await row();
  expect(r1.version).toBe(r0.version);
  expect(r1.filePath).toBe(r0.filePath);
});
```
Запуск: `pnpm --filter @carbone-reports/api test:int`. Expected: новые тесты падают (старые пути, блокировка на время скачивания).

- [ ] **Step 2: Storage и пути**

`storage.ts`:
```ts
  /** Удаляет файл или каталог целиком; отсутствие — не ошибка. */
  async remove(rel: string): Promise<void> {
    await rm(this.path(rel), { recursive: true, force: true });
  }
```
`service.ts`:
```ts
export const templateDir = (id: string) => `templates/${id}`;
export const templateFilePath = (id: string, ext: TemplateExt, version: number) =>
  `${templateDir(id)}/v${version}.${ext}`;
```

- [ ] **Step 3: Маршруты шаблонов**

`routes.ts`:
- `insertTemplate`: `const filePath = templateFilePath(id, v.ext, 1);`. При ошибке удалять `templateDir(id)`, а не только файл.
- `PUT /api/templates/:id/file`:
```ts
  app.put('/api/templates/:id/file', { ...admin, schema: { params: IdParams } }, async (req) => {
    const row = await loadTemplate(db, req.params.id);
    const { ext, data } = await readUpload(req);
    if (ext !== row.fileExt) throw badRequest(`ожидается файл .${row.fileExt}`);
    let written: string | undefined;
    let previous: string | undefined;
    let updated: TemplateRow;
    try {
      updated = await db.transaction(async (tx) => {
        // Блокировка строки: ручная замена не должна пересекаться с callback OnlyOffice.
        const [cur] = await tx.select().from(templates).where(eq(templates.id, row.id)).for('update');
        if (!cur) throw notFound('шаблон');
        // Новая версия — новый файл: при сбое коммита строка продолжает указывать на прежний.
        previous = cur.filePath;
        written = templateFilePath(cur.id, cur.fileExt, cur.version + 1);
        await storage.write(written, data);
        const [u] = await tx
          .update(templates)
          .set({
            version: cur.version + 1,
            filePath: written,
            docKey: randomUUID(),
            updatedAt: new Date(),
            updatedBy: currentUser(req).id,
            lastSaveError: null,
          })
          .where(eq(templates.id, cur.id))
          .returning();
        return u!;
      });
    } catch (err) {
      // Транзакция (включая коммит) не прошла: новый файл — сирота, убираем.
      if (written) await storage.remove(written).catch(() => undefined);
      throw err;
    }
    if (previous && previous !== updated.filePath) {
      await storage
        .remove(previous)
        .catch((e) => req.log.warn({ err: e }, 'старый файл шаблона не удалён'));
    }
    return toAdminDetails(await loadTemplateFull(db, updated.id));
  });
```
`TemplateRow` — тип строки из `../../db/schema`. Если у схемы он называется иначе, используйте `typeof templates.$inferSelect`.
- `DELETE`: после удаления строки `await storage.remove(templateDir(row.id))`. Если путь строки ещё старого формата (`templates/<id>.<ext>`), удалите и его: `await storage.remove(row.filePath)`.
- `duplicate` и `download` читают `row.filePath`, менять их не нужно. `insertTemplate` для копии создаёт `v1`.

- [ ] **Step 4: Callback**

`callback.ts`: скачивание выносится из транзакции.
```ts
  const cb = parsed.data;
  if (![2, 3, 6, 7].includes(cb.status)) return;
  const [current] = await deps.db.select().from(templates).where(eq(templates.id, templateId));
  if (!current) return; // шаблон удалён: подтверждаем, чтобы Document Server не повторял callback
  if (cb.key !== current.docKey) return; // колбэк от закрытой сессии

  if (cb.status === 3 || cb.status === 7) {
    log?.warn({ templateId, status: cb.status }, SAVE_ERRORS[cb.status]);
    await deps.db.update(templates).set({ lastSaveError: SAVE_ERRORS[cb.status]! })
      .where(and(eq(templates.id, templateId), eq(templates.docKey, cb.key)));
    return;
  }
  if (cb.status !== 2 && cb.status !== 6) return;
  const setErrorNow = (msg: string) =>
    deps.db.update(templates).set({ lastSaveError: msg })
      .where(and(eq(templates.id, templateId), eq(templates.docKey, cb.key)));
  if (!cb.url) return void (await setErrorNow('OnlyOffice не передал ссылку на файл'));
  const downloadUrl = toInternalDownloadUrl(cb.url, deps.config.onlyofficeInternalUrl);
  if (!downloadUrl) {
    log?.warn({ templateId }, 'OnlyOffice передал недопустимую ссылку на файл');
    return void (await setErrorNow('OnlyOffice передал недопустимую ссылку на файл'));
  }

  // Скачивание — без блокировки строки (до 60 с); ключ сверяется повторно под блокировкой.
  let file: Buffer;
  try {
    file = await deps.fetchFile(downloadUrl);
  } catch (err) {
    await setErrorNow('не удалось скачать файл из OnlyOffice');
    throw err;
  }
  if (!isZip(file)) return void (await setErrorNow('полученный от OnlyOffice файл не является документом'));

  let written: string | undefined;
  let previous: string | undefined;
  let committed = false;
  try {
    await deps.db.transaction(async (tx) => {
      const [row] = await tx.select().from(templates).where(eq(templates.id, templateId)).for('update');
      // Пока файл скачивался, сессия могла смениться (ручная замена, другой callback).
      if (!row || cb.key !== row.docKey) return;
      written = templateFilePath(row.id, row.fileExt, row.version + 1);
      await deps.storage.write(written, file);
      previous = row.filePath;
      await tx.update(templates).set({
        version: row.version + 1,
        filePath: written,
        updatedAt: new Date(),
        updatedBy: await existingUserId(tx, cb.users?.[0]),
        lastSaveError: null,
        ...(cb.status === 2 ? { docKey: randomUUID() } : {}),
      }).where(eq(templates.id, row.id));
    });
    committed = true;
  } catch (err) {
    if (written) await deps.storage.remove(written).catch(() => undefined);
    throw err;
  }
  if (committed && previous && written && previous !== written) {
    await deps.storage.remove(previous).catch((e) => log?.warn({ err: e }, 'старый файл шаблона не удалён'));
  }
```
- Сохраните существующую семантику ответов и логирования.
- Проверьте, что существующие тесты callback остаются зелёными: обработка медленного скачивания, «финальный» callback после промежуточного, ошибка `boom`. Если какой-то тест опирался на прежнюю сериализацию через блокировку (два параллельных callback), убедитесь, что новая схема даёт тот же итог. Второй callback дождётся блокировки, увидит актуальный `docKey`/`version` и запишет `v+2`. Если ожидания теста иначе не выполнить, поменяйте тест и объясните это в отчёте.
- Импорт `and` из `drizzle-orm`, `templateFilePath` из `../templates/service`.

- [ ] **Step 5: Перенос при старте**

`file-migration.ts`:
```ts
import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { templates } from '../../db/schema';
import type { Storage } from '../../lib/storage';
import { templateFilePath } from './service';

const VERSIONED = /^templates\/[0-9a-f-]+\/v\d+\.[a-z]+$/;

/** Переносит файлы шаблонов со старых путей templates/<id>.<ext> на пути с версией. Идемпотентно. */
export async function migrateTemplateFiles(deps: {
  db: Db;
  storage: Storage;
  log?: { warn(o: unknown, msg?: string): void; info(o: unknown, msg?: string): void };
}): Promise<number> {
  const rows = await deps.db.select().from(templates);
  let moved = 0;
  for (const row of rows) {
    if (VERSIONED.test(row.filePath)) continue;
    if (!(await deps.storage.exists(row.filePath))) {
      deps.log?.warn({ templateId: row.id, filePath: row.filePath }, 'файл шаблона не найден, перенос пропущен');
      continue;
    }
    const target = templateFilePath(row.id, row.fileExt, row.version);
    await deps.storage.write(target, await deps.storage.read(row.filePath));
    await deps.db.update(templates).set({ filePath: target }).where(eq(templates.id, row.id));
    await deps.storage.remove(row.filePath);
    moved++;
  }
  if (moved) deps.log?.info({ moved }, 'файлы шаблонов перенесены на пути с версией');
  return moved;
}
```
`server.ts`: после `await migrateDb(db);` и создания `storage` (сверьте порядок в файле) добавьте `await migrateTemplateFiles({ db, storage, log: app.log })`. Если `app` создаётся позже, используйте логгер, доступный на этом этапе, или вызовите перенос сразу после `buildApp` и до `listen`.

- [ ] **Step 6: Прогон**

```bash
pnpm --filter @carbone-reports/api test && pnpm --filter @carbone-reports/api test:int
```
Expected: всё зелёное. Если тесты в `templates.int.test.ts` и `onlyoffice.int.test.ts` проверяли старый путь, обновите их под новый формат.

- [ ] **Step 7: Живой стек**

```bash
df -h /System/Volumes/Data | tail -1
docker compose --profile demo up -d --build --no-deps --wait api
docker compose logs api | grep -i "перенес" || true
pnpm e2e
```
Expected:
- в логе есть сообщение о переносе: у демо-шаблона и шаблонов smoke старые пути;
- E2E зелёные, в том числе сохранение из OnlyOffice.

Удалите висячий предыдущий образ api.

- [ ] **Step 8: Гейты и коммит**

```bash
pnpm typecheck && pnpm lint && pnpm exec prettier --check . && pnpm test
git add apps/api
git commit -m "feat(api): versioned template files and download outside row lock"
```

---

### Task 7: Восстановление Carbone и непокрытые тесты

**Files:**
- Modify: `scripts/smoke.ts`, `apps/api/test/reports.int.test.ts`

**Interfaces:**
- Produces: флаг `--carbone-restart` у `scripts/smoke.ts`. Шаг выполняется только с флагом и только против стека, поднятого `docker compose` из этого репозитория. Скрипт вызывает `docker compose` через `node:child_process`.

- [ ] **Step 1: Интеграционные тесты истории**

В `apps/api/test/reports.int.test.ts`, `describe('история')`:
```ts
  it('пагинация: страница по RUNS_PAGE_SIZE, total, вторая страница, порядок от новых к старым', async () => {
    const u = await loginAs(t, 'user');
    for (let i = 0; i < RUNS_PAGE_SIZE + 3; i++) {
      const r = await render(u.cookie, tplId, { params: { from: '2026-01-01' }, format: 'pdf' });
      expect(r.statusCode).toBe(201);
    }
    const p1 = (await t.app.inject({ method: 'GET', url: '/api/runs?page=1', headers: { cookie: u.cookie } })).json();
    const p2 = (await t.app.inject({ method: 'GET', url: '/api/runs?page=2', headers: { cookie: u.cookie } })).json();
    expect(p1.total).toBe(RUNS_PAGE_SIZE + 3);
    expect(p1.items).toHaveLength(RUNS_PAGE_SIZE);
    expect(p2.items).toHaveLength(3);
    const ids = [...p1.items, ...p2.items].map((x: { id: string }) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    const times = [...p1.items, ...p2.items].map((x: { createdAt: string }) => Date.parse(x.createdAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
  });

  it('page=0 и нечисловая страница → 400', async () => {
    const u = await loginAs(t, 'user');
    for (const q of ['page=0', 'page=abc']) {
      const r = await t.app.inject({ method: 'GET', url: `/api/runs?${q}`, headers: { cookie: u.cookie } });
      expect(r.statusCode).toBe(400);
    }
  });

  it('файл отчёта удалён с диска → 410', async () => {
    const r = await render(userA, tplId, { params: { from: '2026-01-01' }, format: 'pdf' });
    const runId = r.json().runId;
    const [run] = await t.deps.db.select().from(reportRuns).where(eq(reportRuns.id, runId));
    await t.deps.storage.remove(run!.filePath!);
    const file = await t.app.inject({ method: 'GET', url: `/api/runs/${runId}/file`, headers: { cookie: userA } });
    expect(file.statusCode).toBe(410);
  });
```
- Импорты: `RUNS_PAGE_SIZE` из `@carbone-reports/shared`, `eq`, `reportRuns` из `../src/db/schema`.
- Проверьте, как `RunsQuery` в shared валидирует `page`. Если `page=0` сейчас не отклоняется (нет `.min(1)`), это находка: исправьте схему (`z.coerce.number().int().min(1).default(1)`) и упомяните это в отчёте.
- Тесту пагинации нужен отдельный пользователь: другие тесты файла создают запуски для `userA`.

- [ ] **Step 2: Smoke `--carbone-restart`**

В `scripts/smoke.ts` после основного сценария генерации (найдите шаг, который рендерит отчёт и получает `runId`) добавьте:
```ts
import { execFileSync } from 'node:child_process';

async function carboneRestart(templateId: string) {
  const renderOnce = async () => {
    const r = await api('POST', `/api/reports/${templateId}/render`, { params: SMOKE_PARAMS, format: 'pdf' });
    assert(r.status === 201, `генерация: HTTP ${r.status}`);
    const { runId } = await json<{ runId: string }>(r);
    const f = await api('GET', `/api/runs/${runId}/file`);
    assert(f.status === 200, `файл отчёта: HTTP ${f.status}`);
    return f.headers.get('content-type');
  };
  await step('Carbone: отчёт до пересоздания контейнера', async () => {
    await renderOnce();
  });
  await step('Carbone: пересоздание контейнера (шаблоны в Carbone теряются)', async () => {
    execFileSync('docker', ['compose', 'rm', '-sf', 'carbone'], { stdio: 'inherit' });
    execFileSync('docker', ['compose', 'up', '-d', '--wait', 'carbone'], { stdio: 'inherit' });
  });
  await step('Carbone: отчёт после пересоздания — шаблон загружен повторно', async () => {
    const type = await renderOnce();
    assert(type === 'application/pdf', `content-type: ${type}`);
  });
}
// в main, после основного сценария:
if (process.argv.includes('--carbone-restart')) await carboneRestart(templateId);
```
- `api`, `json`, `step`, `assert` и параметры шаблона подставьте те, что уже есть в `smoke.ts`. `SMOKE_PARAMS` — условное имя для параметров, с которыми smoke рендерит свой шаблон.
- Если у `carbone` в compose нет healthcheck, `--wait` ждёт состояния running. Это допустимо, но тогда первая генерация после пересоздания может попасть на неготовый Carbone. В этом случае `renderOnce` повторяет попытку до 5 раз с паузой 3 с, только для шага «после пересоздания», и каждая попытка печатается.
- Реальный текст ошибки Carbone возьмите из лога API (`docker compose logs api --since 2m | grep -i carbone`). Запишите его в отчёт: он нужен для заметки в Task 8.

- [ ] **Step 3: Прогон**

```bash
pnpm --filter @carbone-reports/api test:int
pnpm stack:demo   # если стек не поднят
BASE_URL=https://localhost:${WEB_HTTPS_PORT:-443} pnpm stack:smoke -- --insecure --carbone-restart
```
Expected:
- интеграционные тесты зелёные;
- smoke зелёный, включая три шага Carbone;
- в логе API видна повторная загрузка шаблона после ответа «Template not found» или 404.

- [ ] **Step 4: Гейты и коммит**

```bash
pnpm typecheck && pnpm lint && pnpm exec prettier --check . && pnpm test
git add scripts/smoke.ts apps/api packages/shared
git commit -m "test: runs pagination, 410, carbone restart smoke"
```

---

### Task 8: E2E «Завершить сессии», полный прогон, заметки

**Files:**
- Create: `e2e/tests/sessions.spec.ts`
- Modify: `docs/superpowers/notes/2026-10-02-backend-follow-ups.md`, `README.md` (если описывает API или SSL)

**Interfaces:**
- Consumes: `e2e/fixtures.ts` (`test`, `expect`, `adminApi`, `loginAdminUi`, `loginUi`); UI из Task 2 (кнопка `aria-label="Завершить сессии"`, диалог с кнопкой «Завершить»).

- [ ] **Step 1: Тест**

`e2e/tests/sessions.spec.ts`:
```ts
import { adminApi, expect, loginAdminUi, loginUi, test } from '../fixtures';

const login = `e2e_s_${Date.now().toString(36)}`;
const password = 'password123';
let userId: string;

test.beforeAll(async () => {
  const api = await adminApi();
  userId = (await api.post<{ id: string }>('/api/users', { login, password, role: 'user' })).id;
});
test.afterAll(async () => {
  if (userId) await (await adminApi()).del(`/api/users/${userId}`);
});

test('админ завершает сессии пользователя: следующий запрос пользователя ведёт на вход', async ({ browser, page }) => {
  // Пользователь в отдельном контексте браузера.
  const userCtx = await browser.newContext({ ignoreHTTPSErrors: true });
  const userPage = await userCtx.newPage();
  await loginUi(userPage, login, password);
  await userPage.goto('/reports');
  await expect(userPage.getByText('Счёт (демо)')).toBeVisible();

  await loginAdminUi(page);
  await page.goto('/admin/users');
  const row = page.getByRole('row', { name: new RegExp(login) });
  await row.getByRole('button', { name: 'Завершить сессии' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Завершить' }).click();
  await expect(page.getByText(`Сессии пользователя ${login} завершены`)).toBeVisible();

  await userPage.goto('/history');
  await expect(userPage).toHaveURL(/\/login/);
  await userCtx.close();
});
```
- Контекст пользователя создаётся вне фикстуры `page`, поэтому проверка CSP на него не распространяется. Это допустимо: страницы те же, что в `user.spec.ts`.
- Если `loginUi` ожидает `Page` из фикстуры, тип подходит и для `userPage`.

- [ ] **Step 2: Полный прогон**

```bash
df -h /System/Volumes/Data | tail -1
pnpm stack:demo
pnpm e2e && pnpm e2e
BASE_URL=https://localhost:${WEB_HTTPS_PORT:-443} pnpm stack:smoke -- --insecure
```
Expected:
- 6 тестов зелёные дважды подряд, нарушений CSP нет;
- smoke зелёный.

Пользователи E2E входят заново после выката Task 1: старые cookie без `sv` недействительны. Это ожидаемо.

- [ ] **Step 3: Заметка о доработках**

В `docs/superpowers/notes/2026-10-02-backend-follow-ups.md`:
- закрыть пункты:
  - «Сессии не отзываются» — сделано: `session_version`, «Завершить сессии», «Выйти везде»;
  - «SSL не проверяет сертификат» — сделано: режимы `disable`/`require`/`verify` и свой CA;
  - «Callback без exp можно переиграть» — сделано: требуется `exp`, допуск 60 с; указать фактическое значение `token.outbox.expires` из Task 5;
  - «Строка блокируется на время скачивания» — сделано;
  - «Если файл записан, а коммит упал…» — сделано: пути с версией;
  - «Тесты не покрывают…» — отметить покрытые пункты (пагинация, 410, чужой секрет, статус 7), открытым оставить только «одновременную работу нескольких пользователей»;
  - Carbone «Template not found» и повторную загрузку — закрыть с реальным текстом ошибки и `content-type` из Task 7;
- добавить раздел «Итоги Плана 4»: что сделано, какие решения приняты по ходу, что осталось открытым.

Если README описывает поле SSL источника или выход, обновите эти места.

- [ ] **Step 4: Остановить стек, гейты, коммит**

```bash
docker compose --profile demo down
pnpm typecheck && pnpm lint && pnpm exec prettier --check . && pnpm test
git add e2e docs README.md
git commit -m "test(e2e): revoke sessions scenario; docs: plan 4 results"
```
