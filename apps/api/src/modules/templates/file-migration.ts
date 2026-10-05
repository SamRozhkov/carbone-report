import { eq } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { templates } from '../../db/schema';
import type { Storage } from '../../lib/storage';
import { templateFilePath } from './service';

const VERSIONED = /^templates\/[0-9a-f-]+\/v\d+\.[a-z]+$/;

/** Переносит файлы шаблонов со старых путей templates/<id>.<ext> на пути с версией. Идемпотентно. */
export async function migrateTemplateFiles(deps: {
  db: Db;
  storage: Storage;
  log?: { warn(o: unknown, msg?: string): void; info(o: unknown, msg?: string): void };
}): Promise<number> {
  const rows = await deps.db.select().from(templates);
  let moved = 0;
  for (const row of rows) {
    if (VERSIONED.test(row.filePath)) continue;
    if (!(await deps.storage.exists(row.filePath))) {
      deps.log?.warn(
        { templateId: row.id, filePath: row.filePath },
        'файл шаблона не найден, перенос пропущен',
      );
      continue;
    }
    // Копия → строка → удаление старого: при сбое на любом шаге повторный запуск доводит перенос.
    const target = templateFilePath(row.id, row.fileExt, row.version);
    await deps.storage.write(target, await deps.storage.read(row.filePath));
    await deps.db.update(templates).set({ filePath: target }).where(eq(templates.id, row.id));
    await deps.storage.remove(row.filePath);
    moved++;
  }
  if (moved) deps.log?.info({ moved }, 'файлы шаблонов перенесены на пути с версией');
  return moved;
}
