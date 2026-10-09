/** Счётчик незавершённых операций: `idle()` выполняется, когда их не осталось. */
export function createInflight() {
  let active = 0;
  let waiters: Array<() => void> = [];
  return {
    enter(): void {
      active++;
    },
    leave(): void {
      if (active === 0) return;
      if (--active === 0) {
        const w = waiters;
        waiters = [];
        for (const f of w) f();
      }
    },
    active: () => active,
    idle: () => (active === 0 ? Promise.resolve() : new Promise<void>((r) => waiters.push(r))),
  };
}

export type Inflight = ReturnType<typeof createInflight>;
