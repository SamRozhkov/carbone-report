import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  emptyState,
  fileStateStore,
  resolveExternally,
  RESOLVED_EXTERNALLY,
  type AgentState,
  type Operation,
} from './state';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'state-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const op = (over: Partial<Operation> = {}): Operation => ({
  id: 'op1',
  type: 'restore',
  requestedBy: 'admin',
  backup: '2026-10-08T03-00-00Z',
  preRestore: null,
  recoveryOf: null,
  maintenanceStartedAt: null,
  phase: 'verify',
  status: 'running',
  startedAt: '2026-10-08T10:00:00.000Z',
  finishedAt: null,
  error: null,
  ...over,
});

describe('fileStateStore', () => {
  it('нет файла — пустое состояние; запись и чтение; временный файл не остаётся', async () => {
    const store = fileStateStore(join(dir, '.op'));
    expect(await store.read()).toEqual(emptyState());
    const s: AgentState = { operation: op(), recovery: null };
    await store.write(s);
    expect(await store.read()).toEqual(s);
    expect(await readdir(join(dir, '.op'))).toEqual(['state.json']);
  });

  it('записи идут по очереди: последняя побеждает, читатель никогда не видит обрезанный JSON', async () => {
    const store = fileStateStore(dir);
    const writes = Array.from({ length: 30 }, (_, i) =>
      store.write({ operation: op({ id: `op${i}`, error: 'x'.repeat(5000) }), recovery: null }),
    );
    const reads = Array.from({ length: 30 }, () => store.read());
    await Promise.all(writes);
    for (const r of await Promise.all(reads))
      expect(r.operation === null || r.operation.id.startsWith('op')).toBe(true);
    expect((await store.read()).operation?.id).toBe('op29');
  });

  it('повреждённый файл — ошибка чтения, а не пустое состояние', async () => {
    await writeFile(join(dir, 'state.json'), '{"operation":');
    await expect(fileStateStore(dir).read()).rejects.toThrow(SyntaxError);
  });
});

describe('resolveExternally (scripts/restore.sh)', () => {
  it('незавершённое восстановление и «требуется восстановление» → failed (resolved externally)', async () => {
    const store = fileStateStore(dir);
    await store.write({
      operation: op({ phase: 'storage', status: 'failed', error: 'сбой' }),
      recovery: {
        codeHash: 'h'.repeat(64),
        attempts: 1,
        backup: '2026-10-08T03-00-00Z',
        preRestore: 'pre-restore-2026-10-08T10-00-00Z',
        phase: 'storage',
        startedAt: '2026-10-08T10:00:05.000Z',
      },
    });
    expect(await resolveExternally(store, new Date('2026-10-08T12:00:00Z'))).toBe(true);
    const s = await store.read();
    expect(s.recovery).toBeNull();
    expect(s.operation).toMatchObject({ status: 'failed', error: RESOLVED_EXTERNALLY });
  });

  it('идущая операция (агент остановлен посреди) → failed с временем окончания', async () => {
    const store = fileStateStore(dir);
    await store.write({ operation: op({ phase: 'db' }), recovery: null });
    expect(await resolveExternally(store, new Date('2026-10-08T12:00:00Z'))).toBe(true);
    expect((await store.read()).operation).toMatchObject({
      status: 'failed',
      error: RESOLVED_EXTERNALLY,
      finishedAt: '2026-10-08T12:00:00.000Z',
    });
  });

  it('нечего отмечать — файл не меняется', async () => {
    const store = fileStateStore(dir);
    const s: AgentState = { operation: op({ status: 'succeeded', phase: 'done' }), recovery: null };
    await store.write(s);
    const before = await readFile(join(dir, 'state.json'), 'utf8');
    expect(await resolveExternally(store)).toBe(false);
    expect(await readFile(join(dir, 'state.json'), 'utf8')).toBe(before);
  });

  it('повреждённый state.json заменяется пустым состоянием', async () => {
    await writeFile(join(dir, 'state.json'), '{"operation":');
    const store = fileStateStore(dir);
    expect(await resolveExternally(store)).toBe(true);
    expect(await store.read()).toEqual(emptyState());
  });
});
