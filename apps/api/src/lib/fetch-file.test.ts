import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFileFetcher } from './fetch-file';

let server: Server;
let base: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/small') {
      res.end(Buffer.from([1, 2, 3, 4, 5]));
    } else if (req.url === '/declared') {
      res.setHeader('content-length', '100');
      res.end(Buffer.alloc(100));
    } else if (req.url === '/chunked') {
      res.write(Buffer.alloc(60));
      res.write(Buffer.alloc(60));
      res.end();
    } else if (req.url === '/redirect') {
      res.writeHead(302, { location: '/small' });
      res.end();
    } else {
      res.writeHead(404);
      res.end('no');
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => {
  server.closeAllConnections();
  return new Promise<void>((r) => server.close(() => r()));
});

describe('fetchFile', () => {
  const fetcher = createFileFetcher({ maxBytes: 64 });
  it('возвращает точные байты небольшого тела', async () => {
    expect([...(await fetcher(`${base}/small`))]).toEqual([1, 2, 3, 4, 5]);
  });
  it('отклоняет по content-length больше лимита', async () => {
    await expect(fetcher(`${base}/declared`)).rejects.toThrow(/слишком большой/);
  });
  it('отклоняет chunked-тело, превышающее лимит', async () => {
    await expect(fetcher(`${base}/chunked`)).rejects.toThrow(/слишком большой/);
  });
  it('отклоняет редирект', async () => {
    await expect(fetcher(`${base}/redirect`)).rejects.toThrow();
  });
  it('отклоняет не-2xx', async () => {
    await expect(fetcher(`${base}/missing`)).rejects.toThrow(/HTTP 404/);
  });
});
