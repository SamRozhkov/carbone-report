import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { parseManifest, type Manifest } from './manifest';

/** Имя бэкапа для восстановления (§26.1). */
export const BACKUP_NAME_RE = /^(pre-restore-)?\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/;
const DIR_RE = /^(?:pre-restore-)?(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})Z(\.partial)?$/;
const PRE_RESTORE_RE = /^pre-restore-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/;

/** Сколько бэкапов pre-restore-* хранить (§26.1); BACKUP_KEEP на них не действует. */
export const PRE_RESTORE_KEEP = 3;

export interface BackupInfo {
  name: string;
  /** ISO-время UTC из имени каталога. */
  createdAt: string;
  dbSize: number | null;
  storageSize: number | null;
  lastMigration: string | null;
  kind: 'regular' | 'pre-restore';
  status: 'ok' | 'partial';
}

/** Имя каталога, как `date -u +%Y-%m-%dT%H-%M-%SZ` в backup.sh. */
export function backupName(at: Date, prefix: '' | 'pre-restore-' = ''): string {
  return (
    prefix +
    at
      .toISOString()
      .replace(/\.\d{3}Z$/, 'Z')
      .replaceAll(':', '-')
  );
}

async function sizeOf(path: string): Promise<number | null> {
  try {
    return (await stat(path)).size;
  } catch {
    return null;
  }
}

/**
 * Каталоги бэкапов, новые сверху. `status: ok` — только завершённый каталог (без .partial)
 * с читаемым manifest.txt; остальное — `partial` (восстановить его нельзя). Каталог, исчезнувший
 * между readdir и stat (ротация), пропускается.
 */
export async function listBackups(dir: string): Promise<BackupInfo[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const out: BackupInfo[] = [];
  for (const name of names) {
    const m = DIR_RE.exec(name);
    if (!m) continue;
    const path = join(dir, name);
    try {
      if (!(await stat(path)).isDirectory()) continue;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw e;
    }
    let manifest: Manifest | null;
    try {
      manifest = parseManifest(await readFile(join(path, 'manifest.txt'), 'utf8'));
    } catch {
      manifest = null;
    }
    out.push({
      name,
      createdAt: `${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`,
      dbSize: manifest?.files['db.dump'].size ?? (await sizeOf(join(path, 'db.dump'))),
      storageSize:
        manifest?.files['storage.tar.gz'].size ?? (await sizeOf(join(path, 'storage.tar.gz'))),
      lastMigration: manifest?.lastMigration ?? null,
      kind: name.startsWith('pre-restore-') ? 'pre-restore' : 'regular',
      status: m[5] || !manifest ? 'partial' : 'ok',
    });
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.name.localeCompare(a.name));
}

/**
 * Какие завершённые pre-restore-* удалить, чтобы осталось keep новых. protect — бэкап, из которого
 * сейчас восстанавливают: его ротация не удаляет никогда (иначе восстановление из самого старого
 * pre-restore удалило бы собственный источник).
 */
export function selectPreRestoreToDelete(
  names: string[],
  keep = PRE_RESTORE_KEEP,
  protect: string | null = null,
): string[] {
  return names
    .filter((n) => PRE_RESTORE_RE.test(n))
    .sort()
    .reverse()
    .slice(keep)
    .filter((n) => n !== protect);
}

export async function rotatePreRestore(
  dir: string,
  keep = PRE_RESTORE_KEEP,
  protect: string | null = null,
): Promise<string[]> {
  const victims = selectPreRestoreToDelete(await readdir(dir), keep, protect);
  for (const v of victims) await rm(join(dir, v), { recursive: true, force: true });
  return victims;
}
