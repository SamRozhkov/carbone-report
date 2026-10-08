import { expect, test } from '@playwright/test';

test('favicon: /favicon.svg отдаётся, /favicon.ico — 404, а не index.html', async ({ request }) => {
  const svg = await request.get('/favicon.svg');
  expect(svg.status()).toBe(200);
  expect(svg.headers()['content-type']).toContain('image/svg+xml');
  expect(await svg.text()).toContain('viewBox="0 0 32 32"');
  const ico = await request.get('/favicon.ico');
  expect(ico.status()).toBe(404);
  expect(await ico.text()).not.toContain('<div id="root">');
});
