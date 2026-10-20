import { Client } from 'ldapts';
import type { LdapConfig } from '../../config';

export interface LdapAuthenticator {
  /**
   * Связка логин/пароль подтверждена сервером LDAP — возвращает канонический логин, иначе null.
   * Без LDAP_LOGIN_ATTRIBUTE канонический логин — введённая строка (поведение прежних версий).
   * С ним — значение этого атрибута найденной записи: оно может отличаться от того, что ввёл
   * пользователь, ведь LDAP_USER_FILTER вправе искать запись по нескольким атрибутам
   * (например, по логину и по почте), а локальный аккаунт при этом должен быть один и тот же
   * независимо от того, как человек вошёл.
   */
  authenticate(login: string, password: string): Promise<string | null>;
}

/** Значение LDAP-атрибута к строке: ldapts отдаёт string, string[] или Buffer в зависимости от поля. */
function attributeToString(
  value: string | string[] | Buffer | Buffer[] | undefined,
): string | null {
  if (value == null) return null;
  const first = Array.isArray(value) ? value[0] : value;
  if (first == null) return null;
  return Buffer.isBuffer(first) ? first.toString('utf8') : first;
}

/**
 * LDAP допускает unauthenticated bind: пустой пароль с валидным DN считается
 * успехом. Поэтому пустой пароль отклоняем раньше, не доходя до сервера.
 */
function isUsablePassword(password: string): boolean {
  return password.length > 0;
}

// RFC 4515: экранирование спецсимволов фильтра поиска против LDAP-инъекции.
export function escapeLdapFilter(input: string): string {
  const escaped = input.replace(/[\\*()]/g, (c) => {
    switch (c) {
      case '\\':
        return '\\5c';
      case '*':
        return '\\2a';
      case '(':
        return '\\28';
      default:
        return '\\29';
    }
  });
  return escaped.split('\u0000').join('\\00');
}

/**
 * Фильтр поиска: экранированный логин подставляется во все `%s` шаблона. Подстановка —
 * функцией: в строке замены `String.replace` символы `$&`, `` $` ``, `$'` и `$$` — шаблоны,
 * и логин с ними изменил бы фильтр уже после экранирования.
 */
export function buildLdapFilter(template: string, login: string): string {
  const escaped = escapeLdapFilter(login);
  return template.replaceAll('%s', () => escaped);
}

/** Сроки по умолчанию: молчащий сервер LDAP не должен подвешивать вход (LDAP опрашивается первым). */
export interface LdapTimeouts {
  /** Установка TCP/TLS-соединения, мс. */
  connectTimeoutMs?: number;
  /** Ответ на каждую операцию (bind, search), мс. */
  timeoutMs?: number;
}

export function createLdapAuthenticator(
  config: LdapConfig,
  log: { warn(msg: string): void },
  { connectTimeoutMs = 5_000, timeoutMs = 10_000 }: LdapTimeouts = {},
): LdapAuthenticator {
  // tlsOptions имеет смысл только для ldaps://; на обычном ldap:// одно его
  // наличие в опциях клиента ломает соединение — контроллер домена рвёт его
  // (ECONNRESET) ещё на bind, хотя сам tlsOptions формально ни на что не влияет.
  const tlsOptions = config.url.startsWith('ldaps://')
    ? { rejectUnauthorized: config.tlsRejectUnauthorized }
    : undefined;
  const clientOptions = (): ConstructorParameters<typeof Client>[0] => ({
    url: config.url,
    tlsOptions,
    connectTimeout: connectTimeoutMs,
    timeout: timeoutMs,
  });
  return {
    async authenticate(login, password) {
      if (!isUsablePassword(password)) return null;
      const filter = buildLdapFilter(config.userFilter, login);
      const searchClient = new Client(clientOptions());
      let userDn: string;
      let canonicalLogin: string;
      try {
        if (config.bindDn) {
          await searchClient.bind(config.bindDn, config.bindPassword ?? '');
        }
        const attribute = config.loginAttribute;
        const { searchEntries } = await searchClient.search(config.baseDn, {
          scope: 'sub',
          filter,
          attributes: attribute ? ['dn', attribute] : ['dn'],
        });
        if (searchEntries.length !== 1) return null;
        const entry = searchEntries[0]!;
        userDn = entry.dn;
        if (attribute) {
          // Запись найдена (например, по почте), но без атрибута канонического логина —
          // заводить локальный аккаунт не по чему, вход отклоняется.
          const resolved = attributeToString(entry[attribute]);
          if (!resolved) {
            log.warn(`LDAP: у найденной записи нет атрибута ${attribute} (LDAP_LOGIN_ATTRIBUTE)`);
            return null;
          }
          canonicalLogin = resolved;
        } else {
          canonicalLogin = login;
        }
      } catch (err) {
        log.warn(`LDAP: поиск пользователя не удался — ${(err as Error).message}`);
        return null;
      } finally {
        await searchClient.unbind().catch(() => {});
      }

      const userClient = new Client(clientOptions());
      try {
        await userClient.bind(userDn, password);
        return canonicalLogin;
      } catch {
        return null;
      } finally {
        await userClient.unbind().catch(() => {});
      }
    },
  };
}
