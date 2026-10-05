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
  ])('обход каталога не выходит из /cache/files/: %s', (url) => {
    const r = toInternalDownloadUrl(url, BASE);
    if (r !== null) {
      expect(new URL(r).pathname.startsWith('/cache/files/')).toBe(true);
      expect(r).not.toMatch(/\.\.|%2e%2e|%2f/i);
    }
  });
});
