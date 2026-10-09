// Разработческий скрипт (не для CI): дописывает эталоны Carbone EE 5.15.3 новым пробам.
// Берёт JSON-файл со случаями (формат — packages/carbone/test/golden/README.md); для случаев без `expect`
// поднимает carbone/carbone-ee:full-5.15.3-fonts, рендерит каждый шаблон и записывает `expect.text` / `expect.error`.
// Пример: pnpm exec tsx scripts/carbone-parity.ts probes.json
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

interface GoldenCase {
  id: string;
  template: string;
  raw?: string[];
  rels?: string;
  data?: unknown;
  options?: Record<string, unknown>;
  expect?: { text?: string; error?: string };
  skip?: string;
}
interface GoldenFile {
  cases: GoldenCase[];
  [key: string]: unknown;
}
interface GoldenLib {
  buildDocx(template: string, raw?: string[], rels?: string): Promise<Buffer>;
  docxText(buffer: Buffer): Promise<string>;
  normalizeError(message: string): string;
}

const IMAGE = 'carbone/carbone-ee:full-5.15.3-fonts';
const require = createRequire(import.meta.url);
const lib = require('../packages/carbone/test/golden-lib.js') as GoldenLib;

const docker = (...args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim();

async function waitReady(base: string): Promise<void> {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${base}/status`)).ok) return;
    } catch {
      // контейнер ещё стартует
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('Carbone EE не поднялся за 120 с');
}

async function renderOne(base: string, c: GoldenCase): Promise<{ text?: string; error?: string }> {
  const docx = await lib.buildDocx(c.template, c.raw, c.rels);
  const form = new FormData();
  form.append('template', new Blob([new Uint8Array(docx)]), 'template.docx');
  const up = await fetch(`${base}/template`, {
    method: 'POST',
    headers: { 'carbone-version': '5' },
    body: form,
  });
  const upJson = (await up.json()) as {
    success?: boolean;
    error?: string;
    data?: { templateId: string };
  };
  if (!upJson.success || !upJson.data)
    return { error: lib.normalizeError(upJson.error ?? 'upload failed') };
  const res = await fetch(`${base}/render/${upJson.data.templateId}?download=true`, {
    method: 'POST',
    headers: { 'carbone-version': '5', 'content-type': 'application/json' },
    body: JSON.stringify({ data: c.data ?? {}, convertTo: 'docx', ...c.options }),
  });
  if (!res.ok) {
    const json = (await res.json()) as { error?: string };
    return { error: lib.normalizeError(json.error ?? `HTTP ${res.status}`) };
  }
  return { text: await lib.docxText(Buffer.from(await res.arrayBuffer())) };
}

async function main(): Promise<void> {
  const file = process.argv[2];
  if (!file) throw new Error('Использование: pnpm exec tsx scripts/carbone-parity.ts <файл.json>');
  const path = resolve(file);
  const golden = JSON.parse(readFileSync(path, 'utf8')) as GoldenFile;
  const todo = golden.cases.filter((c) => !c.expect && !c.skip);
  if (todo.length === 0) {
    console.log('Все случаи уже имеют expect — нечего записывать.');
    return;
  }
  console.warn(
    `Внимание: образ ${IMAGE} весит 3,7 ГБ; скрипт только для ручного запуска, в CI не используется.`,
  );
  const container = docker('run', '-d', '--rm', '-p', '127.0.0.1::4000', IMAGE);
  try {
    const port = docker('port', container, '4000/tcp').split('\n')[0]?.split(':').pop();
    const base = `http://127.0.0.1:${port}`;
    await waitReady(base);
    for (const c of todo) {
      c.expect = await renderOne(base, c);
      console.log(
        `${c.id}: ${c.expect.error !== undefined ? `ошибка ${c.expect.error}` : 'текст записан'}`,
      );
    }
    writeFileSync(path, JSON.stringify(golden, null, 2) + '\n');
  } finally {
    docker('stop', container);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
