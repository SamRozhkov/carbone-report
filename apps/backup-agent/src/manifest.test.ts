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
    expect(
      parseManifest(text.replace(`last_migration=${h('a')}`, 'last_migration=?')).lastMigration,
    ).toBeNull();
    expect(
      parseManifest(text.replace(`last_migration=${h('a')}`, 'last_migration=')).lastMigration,
    ).toBeNull();
  });
  it('CRLF и посторонние строки не мешают', () => {
    expect(
      parseManifest(`# заметка\r\n${text.replaceAll('\n', '\r\n')}`).files['db.dump'].size,
    ).toBe(123);
  });
  it('нет строки файла — ошибка', () => {
    expect(() => parseManifest(text.replace(/^storage.*$/m, ''))).toThrow(
      'manifest.txt: нет строки storage.tar.gz',
    );
  });
});
