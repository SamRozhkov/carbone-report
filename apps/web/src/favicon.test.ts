/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('favicon', () => {
  it('index.html ссылается на /favicon.svg', () => {
    const doc = new DOMParser().parseFromString(read('../index.html'), 'text/html');
    const link = doc.querySelector('link[rel="icon"]');
    expect(link?.getAttribute('type')).toBe('image/svg+xml');
    expect(link?.getAttribute('href')).toBe('/favicon.svg');
  });

  it('public/favicon.svg — корректный SVG 32×32', () => {
    const doc = new DOMParser().parseFromString(read('../public/favicon.svg'), 'image/svg+xml');
    expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
    expect(doc.documentElement.tagName).toBe('svg');
    expect(doc.documentElement.getAttribute('viewBox')).toBe('0 0 32 32');
  });

  it('nginx не отдаёт index.html вместо /favicon.ico', () => {
    expect(read('../../../docker/nginx/templates/common.conf.template')).toMatch(
      /location = \/favicon\.ico \{ return 404; \}/,
    );
  });
});
