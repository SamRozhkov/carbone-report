import { describe, expect, it } from 'vitest';
import { createInflight } from './inflight';

describe('createInflight', () => {
  it('idle сразу, если операций нет', async () => {
    const f = createInflight();
    await f.idle();
    expect(f.active()).toBe(0);
  });

  it('idle — после завершения последней операции', async () => {
    const f = createInflight();
    f.enter();
    f.enter();
    let done = false;
    const p = f.idle().then(() => (done = true));
    f.leave();
    await Promise.resolve();
    expect(done).toBe(false);
    f.leave();
    await p;
    expect(done).toBe(true);
    expect(f.active()).toBe(0);
  });

  it('лишний leave не уводит счётчик в минус', () => {
    const f = createInflight();
    f.leave();
    expect(f.active()).toBe(0);
  });
});
