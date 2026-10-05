import { describe, expect, it } from 'vitest';
import { toInternalDownloadUrl } from './download-url';

const BASE = 'http://onlyoffice';
const CACHE = '/cache/files/data/key_2188/output.docx/output.docx';
const QUERY = '?md5=9Y3e3zXiObjMqLuson0liQ&expires=1791179953&filename=output.docx';

describe('toInternalDownloadUrl', () => {
  it('публичный https-адрес с префиксом /onlyoffice → внутренний, query сохранён', () => {
    expect(toInternalDownloadUrl(`https://localhost:8443/onlyoffice${CACHE}${QUERY}`, BASE)).toBe(
      `${BASE}${CACHE}${QUERY}`,
    );
  });

  it('внутренний адрес Document Server остаётся внутренним', () => {
    expect(toInternalDownloadUrl(`http://onlyoffice${CACHE}${QUERY}`, BASE)).toBe(
      `${BASE}${CACHE}${QUERY}`,
    );
  });

  it('хост и протокол исходной ссылки игнорируются', () => {
    expect(toInternalDownloadUrl(`http://evil.example:9000/onlyoffice${CACHE}`, BASE)).toBe(
      `${BASE}${CACHE}`,
    );
  });

  it.each([
    'https://localhost:8443/onlyoffice/web-apps/x',
    'https://localhost:8443/etc/passwd',
    'http://onlyoffice/cache/filesX/a',
    'http://onlyoffice/onlyoffice/web-apps/cache/files/a',
  ])('путь вне /cache/files/ → null: %s', (url) => {
    expect(toInternalDownloadUrl(url, BASE)).toBeNull();
  });

  it.each(['not a url', '', '/cache/files/relative'])('мусор → null: %j', (url) => {
    expect(toInternalDownloadUrl(url, BASE)).toBeNull();
  });

  it.each([
    'https://localhost:8443/onlyoffice/cache/files/../../x',
    'https://localhost:8443/onlyoffice/cache/files/%2e%2e/%2e%2e/x',
    'https://localhost:8443/onlyoffice/cache/files/..%2f..%2fx',
    'https://localhost:8443/onlyoffice/cache/files/..%2F..%2Fx',
    'https://localhost:8443/onlyoffice/cache/files/..\\..\\x',
    'https://localhost:8443/onlyoffice/cache/files/..%5c..%5cx',
    'https://localhost:8443/onlyoffice/cache/files/..%5C..%5Cx',
  ])('обход каталога → null: %s', (url) => {
    expect(toInternalDownloadUrl(url, BASE)).toBeNull();
  });

  it('двойное кодирование %252e%252e остаётся литералом внутри /cache/files/', () => {
    // Декодирование не выполняется, поэтому «%252e%252e» — просто имя каталога. Безопасно: хост
    // фиксирован (internalBase), а путь остаётся под /cache/files/ Document Server.
    expect(
      toInternalDownloadUrl('https://localhost:8443/onlyoffice/cache/files/%252e%252e/x', BASE),
    ).toBe(`${BASE}/cache/files/%252e%252e/x`);
  });
});
