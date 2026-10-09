import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRenderHandoff, type RenderHandoff } from './handoff';

const secret = new TextEncoder().encode('x'.repeat(32));
const other = new TextEncoder().encode('y'.repeat(32));
let h: RenderHandoff;
afterEach(() => {
  h?.close();
  vi.useRealTimers();
});

describe('RenderHandoff', () => {
  it('выдаёт файл по токену один раз', async () => {
    h = createRenderHandoff(secret);
    const { id, token } = await h.put(Buffer.from('PK..'), 'docx', Date.now() + 10_000);
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    const got = await h.take(id, token);
    expect(got).toEqual({ file: Buffer.from('PK..'), ext: 'docx' });
    expect(await h.take(id, token)).toBe('gone');
  });

  it('чужой токен, токен другого файла или подпись другим ключом — forbidden, файл остаётся', async () => {
    h = createRenderHandoff(secret);
    const a = await h.put(Buffer.from('a'), 'docx', Date.now() + 10_000);
    const b = await h.put(Buffer.from('b'), 'docx', Date.now() + 10_000);
    expect(await h.take(a.id, b.token)).toBe('forbidden');
    expect(await h.take(a.id, 'мусор')).toBe('forbidden');
    const forged = createRenderHandoff(other);
    const f = await forged.put(Buffer.from('f'), 'docx', Date.now() + 10_000);
    expect(await h.take(a.id, f.token)).toBe('forbidden');
    forged.close();
    expect(await h.take(a.id, a.token)).toEqual({ file: Buffer.from('a'), ext: 'docx' });
  });

  it('по сроку файл удаляется сам', async () => {
    vi.useFakeTimers();
    h = createRenderHandoff(secret);
    const { id, token } = await h.put(Buffer.from('a'), 'docx', Date.now() + 1_000);
    vi.advanceTimersByTime(1_001);
    expect(await h.take(id, token)).toBe('gone');
  });

  it('remove удаляет файл до выдачи', async () => {
    h = createRenderHandoff(secret);
    const { id, token } = await h.put(Buffer.from('a'), 'docx', Date.now() + 10_000);
    h.remove(id);
    expect(await h.take(id, token)).toBe('gone');
  });
});
