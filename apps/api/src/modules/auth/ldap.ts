import { Client } from 'ldapts';
import type { LdapConfig } from '../../config';

export interface LdapAuthenticator {
  /** true — связка логин/пароль подтверждена сервером LDAP. */
  authenticate(login: string, password: string): Promise<boolean>;
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
      if (!isUsablePassword(password)) return false;
      const filter = buildLdapFilter(config.userFilter, login);
      const searchClient = new Client(clientOptions());
      let userDn: string;
      try {
        if (config.bindDn) {
          await searchClient.bind(config.bindDn, config.bindPassword ?? '');
        }
        const { searchEntries } = await searchClient.search(config.baseDn, {
          scope: 'sub',
          filter,
          attributes: ['dn'],
        });
        if (searchEntries.length !== 1) return false;
        userDn = searchEntries[0]!.dn;
      } catch (err) {
        log.warn(`LDAP: поиск пользователя не удался — ${(err as Error).message}`);
        return false;
      } finally {
        await searchClient.unbind().catch(() => {});
      }

      const userClient = new Client(clientOptions());
      try {
        await userClient.bind(userDn, password);
        return true;
      } catch {
        return false;
      } finally {
        await userClient.unbind().catch(() => {});
      }
    },
  };
}
