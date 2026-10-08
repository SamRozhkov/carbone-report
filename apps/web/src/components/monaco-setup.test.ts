/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Путь через переменную: Vite переписывает литерал `new URL('./x', import.meta.url)` в http-адрес ассета,
// и fileURLToPath падает с «The URL must be of scheme file».
const rel = './monaco-setup.ts';
const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const imports = [...src.matchAll(/^import\s+(?:[^'"]+\s+from\s+)?'([^']+)';/gm)].flatMap((m) =>
  m[1] ? [m[1]] : [],
);

describe('monaco-setup', () => {
  it('не тянет monaco-editor целиком', () => {
    expect(imports).not.toContain('monaco-editor');
    expect(imports).toContain('monaco-editor/editor/editor.api');
  });

  it('подключены только SQL и JSON (с воркером)', () => {
    expect(imports).toContain('monaco-editor/languages/definitions/sql/register');
    expect(imports).toContain('monaco-editor/language/json/monaco.contribution');
    expect(imports).toContain('monaco-editor/language/json/json.worker?worker');
    const languages = imports.filter((i) => /monaco-editor\/(basic-)?languages?\//.test(i));
    expect(languages.every((i) => /\/(sql|json)\//.test(i))).toBe(true);
  });

  it('подключены автодополнение, сообщение read-only и Ctrl+M', () => {
    expect(imports).toContain('monaco-editor/editor/contrib/suggest/browser/suggestController');
    expect(imports).toContain('monaco-editor/features/readOnlyMessage/register');
    expect(imports).toContain('monaco-editor/features/toggleTabFocusMode/register');
  });
});
