# Keycloak / OpenID Connect

Интеграция выключена по умолчанию (`OIDC_ENABLED=false`). Страница входа и её кнопки не меняются.
LDAP и локальный вход продолжают работать. Сервис Keycloak не устанавливается этим изменением.

## Подключение после отдельного решения о включении

1. Создать в своём realm клиент OIDC `carbone-reports`: Client authentication включено,
   Standard flow включён, PKCE S256; Direct access grants и Implicit flow выключены.
2. Задать **точные** адреса (без wildcard):
   - Valid redirect URI: `https://reports.example.org/api/auth/oidc/callback`;
   - Valid post logout redirect URI: `https://reports.example.org/login`;
   - Backchannel logout URL: `https://reports.example.org/api/auth/oidc/backchannel-logout`;
   - Backchannel logout session required включено. ID/logout токены подписываются RS256.
3. Обеспечить `preferred_username` в ID token (scope `profile`). Для уже существующих LDAP-аккаунтов
   он обычно соответствует `sAMAccountName`. Источник AD/LDAP настраивается в Keycloak отдельно.
4. В защищённом `.env` сервера (права 600) заполнить:

```dotenv
OIDC_ENABLED=true
OIDC_ISSUER=https://sso.example.org/realms/yg
OIDC_CLIENT_ID=carbone-reports
OIDC_CLIENT_SECRET=<секрет клиента>
OIDC_REDIRECT_URI=https://reports.example.org/api/auth/oidc/callback
OIDC_POST_LOGOUT_REDIRECT_URI=https://reports.example.org/login
COOKIE_SECURE=true
```

Issuer и callback должны использовать HTTPS с доверенным сертификатом. Для внутреннего CA можно
передать Node `NODE_EXTRA_CA_CERTS` с доступным CA-файлом через compose override; проверка TLS не отключается.
Секрет клиента хранится только у API. После изменения конфигурации пересоздать API-контейнер.
Прямой адрес для проверки: `/api/auth/oidc/login?next=/reports`. Сам по себе этот адрес не добавляет кнопку.

## Пользователи, роли и сессии

- Идентичность хранится по `issuer + sub`, не по почте или отображаемому логину.
- Новый пользователь получает локальную роль `user` и случайный неизвестный локальный пароль.
- Существующие роли, группы, история и локальные блокировки остаются в приложении.
- При совпадении логина с существующим аккаунтом вход возвращает `OIDC_ACCOUNT_LINK_REQUIRED`;
  автоматического объединения и создания дубля нет.
- Встроенный `ADMIN_LOGIN` используется только для аварийного локального входа и не привязывается.
- Аккаунты, созданные первым входом через Keycloak (`users.auth_source = 'oidc'`), входят только через
  Keycloak: вход через LDAP с тем же логином отклоняется, даже если запись каталога найдена и пароль верен.
  Пользователи LDAP входят через LDAP, а через Keycloak — после явной привязки администратором
  (привязка `auth_source` не меняет). Realm следует настроить без самостоятельной регистрации
  (User registration выключено) и без редактирования username пользователями (Edit username выключено):
  иначе человек сможет выбрать `preferred_username`, совпадающий с чужим логином.
- Привязка существующего пользователя: авторизованный локальный администратор выполняет
  `POST /api/admin/auth/oidc/identities` с JSON `{"userId":"<локальный UUID>","subject":"<sub из Keycloak>"}`.
  Issuer берётся из конфигурации API, а не из запроса. Получать `sub` следует из доверенной админки Keycloak.
- Отвязка: `DELETE /api/admin/auth/oidc/identities/<локальный UUID>`; OIDC-сессии отзываются.
- Коды входа одноразовые: state, nonce, PKCE и привязка к HttpOnly cookie; состояние хранится в Redis 10 минут.
  При отказе Redis OIDC закрывается, локальный/LDAP-вход остаётся доступным.
- Токены Keycloak не сохраняются в браузере, БД или логах приложения. Refresh token не используется:
  локальная OIDC-сессия действует столько же, сколько обычная сессия приложения (12 часов), независимо
  от `exp` ID token. Досрочно её завершают back-channel logout, выход через Keycloak, блокировка или
  отвязка. После истечения требуется новый переход через OIDC; действующая SSO-сессия Keycloak может
  позволить пройти его без повторного ввода пароля.
- В журнал запросов адреса маршрутов `/api/auth/oidc/*` попадают без query (код авторизации и state
  не пишутся). Входы через Keycloak, привязка и отвязка пишутся с `userId`, без токенов.
- Истёкшие OIDC-сессии и отозванные больше суток назад удаляются периодической очисткой (раз в час).
- `/api/auth/logout` отзывает текущую локальную OIDC-сессию. Для глобального выхода
  `POST /api/auth/oidc/logout` возвращает `url`, на который клиент должен перейти верхним окном.
  Keycloak может запросить подтверждение выхода, поскольку ID token hint не хранится.
- Подписанный back-channel logout немедленно отзывает соответствующие OIDC-сессии. Лимит — 600 запросов
  в минуту с адреса. Если API не смог получить discovery или ключи (JWKS) Keycloak, ответ — 503
  (Keycloak покажет сбой доставки); неверный токен — 400. Отказы пишутся в журнал с причиной, без токена.
  При выключении OIDC ранее выданные OIDC-сессии больше не принимаются.

## Проверки и откат

Миграция `0013_oidc` добавляет таблицы `oidc_identities` и `oidc_sessions` и делает логин
пользователя уникальным без учёта регистра (индекс `lower(login)`). Если в базе есть логины,
отличающиеся только регистром (`Ivan` и `ivan`), миграция не пройдёт с ошибкой
«логины, отличающиеся только регистром: …» — переименуйте их заранее. Найти такие логины до обновления:

```sql
SELECT lower(login) AS key, string_agg(login, ', ' ORDER BY login) AS logins
FROM users
GROUP BY lower(login)
HAVING count(*) > 1
ORDER BY 1;
```

Миграция также добавляет колонку `users.auth_source` (`local`, `ldap`, `oidc`); существующие
пользователи получают `local`.
Существующие пользователи и отчёты не меняются. Бэкап должен включать новую миграцию:
образ агента backup пересобирается вместе с API.

Тесты протокола используют собственный тестовый HTTPS IdP и тестовый сертификат; скрипт `test`
сам добавляет его в доверенные (`NODE_EXTRA_CA_CERTS`):

```bash
pnpm --filter @carbone-reports/api test
```

Маршруты OIDC с PostgreSQL и Redis проверяет интеграционный `apps/api/test/oidc.int.test.ts`
(testcontainers, входит в `pnpm test:int` и CI):

```bash
pnpm --filter @carbone-reports/api exec vitest run --config vitest.int.config.ts test/oidc.int.test.ts
```

Для немедленного отключения установить `OIDC_ENABLED=false` и пересоздать API. Возврат прежних образов
возможен без удаления добавленных таблиц; база не требует обратной миграции. Резервную копию хранить отдельно.
