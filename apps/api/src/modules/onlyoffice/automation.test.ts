import { describe, expect, it, vi } from 'vitest';
import type { OnlyOfficeCommands } from '../../deps';
import { createAutomationProbe } from './automation';

function setup(license: OnlyOfficeCommands['license']) {
  const fn = vi.fn(license);
  let now = 1_000_000;
  const probe = createAutomationProbe({ forceSave: async () => {}, license: fn }, () => now);
  return { fn, probe, tick: (ms: number) => (now += ms) };
}

describe('createAutomationProbe', () => {
  it.each([
    [2, 3, true],
    [1, 7, true],
    [0, 3, false],
    [2, 2, false],
    [2, 6, false],
  ])('packageType %i, resultType %i → %s', async (packageType, resultType, expected) => {
    const { probe } = setup(async () => ({ packageType, resultType }));
    expect(await probe()).toBe(expected);
  });

  it('результат кэшируется на 10 минут', async () => {
    const { fn, probe, tick } = setup(async () => ({ packageType: 2, resultType: 3 }));
    await probe();
    tick(10 * 60_000);
    await probe();
    expect(fn).toHaveBeenCalledTimes(1);
    tick(1);
    await probe();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('ошибка → false, повтор не раньше чем через 60 с', async () => {
    let fail = true;
    const { fn, probe, tick } = setup(async () => {
      if (fail) throw new Error('down');
      return { packageType: 2, resultType: 3 };
    });
    expect(await probe()).toBe(false);
    fail = false;
    tick(59_999);
    expect(await probe()).toBe(false);
    expect(fn).toHaveBeenCalledTimes(1);
    tick(1);
    expect(await probe()).toBe(true);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('параллельные вызовы делят один запрос', async () => {
    const { fn, probe } = setup(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return { packageType: 2, resultType: 3 };
    });
    expect(await Promise.all([probe(), probe(), probe()])).toEqual([true, true, true]);
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
