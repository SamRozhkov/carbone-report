/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const src = readFileSync(resolve(process.cwd(), 'src/components/monaco-setup.ts'), 'utf8');
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
});
