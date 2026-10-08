import { describe, expect, it } from 'vitest';
import { buildLdapFilter, escapeLdapFilter } from './ldap';

describe('escapeLdapFilter', () => {
  it('экранирует спецсимволы фильтра по RFC 4515', () => {
    expect(escapeLdapFilter('a*b')).toBe('a\\2ab');
    expect(escapeLdapFilter('(x)')).toBe('\\28x\\29');
    expect(escapeLdapFilter('a\\b')).toBe('a\\5cb');
    expect(escapeLdapFilter('a\u0000b')).toBe('a\\00b');
  });
  it('обычный логин не меняет, включая кириллицу и точки', () => {
    expect(escapeLdapFilter('ivan.petrov')).toBe('ivan.petrov');
    expect(escapeLdapFilter('иванов')).toBe('иванов');
  });
});

describe('buildLdapFilter', () => {
  it('подставляет экранированный логин вместо %s', () => {
    expect(buildLdapFilter('(uid=%s)', 'fry')).toBe('(uid=fry)');
    expect(buildLdapFilter('(uid=%s)', '*)(uid=*')).toBe('(uid=\\2a\\29\\28uid=\\2a)');
  });
  it('подставляет логин во все вхождения %s', () => {
    expect(buildLdapFilter('(|(uid=%s)(mail=%s))', 'fry')).toBe('(|(uid=fry)(mail=fry))');
  });
  it('символы $ в логине подставляются буквально, а не как шаблоны замены', () => {
    expect(buildLdapFilter('(uid=%s)', 'a$$b')).toBe('(uid=a$$b)');
    expect(buildLdapFilter('(uid=%s)', '$&')).toBe('(uid=$&)');
    expect(buildLdapFilter('(uid=%s)', '$`')).toBe('(uid=$`)');
    expect(buildLdapFilter('(uid=%s)', "$'")).toBe("(uid=$')");
  });
});
