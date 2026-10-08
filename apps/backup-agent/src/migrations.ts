import { readMigrationFiles } from 'drizzle-orm/migrator';

export const FUTURE_BACKUP = 'бэкап создан более новой версией приложения';

/**
 * Хеши миграций в образе (/agent/drizzle — apps/api/drizzle того же коммита). drizzle считает
 * hash как sha256 текста SQL-файла и пишет его в drizzle.__drizzle_migrations; backup.sh кладёт
 * последний из них в manifest.txt как last_migration.
 */
export function bundledMigrationHashes(folder: string): string[] {
  return readMigrationFiles({ migrationsFolder: folder }).map((m) => m.hash);
}

/** Бэкап можно восстановить, только если его схема — одна из известных этой версии (§26.2, verify). */
export function assertKnownMigration(last: string | null, known: readonly string[]): void {
  if (!last) throw new Error('в manifest.txt нет last_migration: версия схемы бэкапа неизвестна');
  if (!known.includes(last)) throw new Error(FUTURE_BACKUP);
}
