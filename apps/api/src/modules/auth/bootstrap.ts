import { count } from 'drizzle-orm';
import { users } from '../../db/schema';
import type { AppDeps } from '../../deps';
import { hashPassword } from './password';

export async function ensureAdmin(deps: AppDeps, log: { warn(msg: string): void }): Promise<void> {
  const { adminLogin, adminPassword } = deps.config;
  const [r] = await deps.db.select({ n: count() }).from(users);
  if (r && r.n > 0) return;
  if (!adminLogin || !adminPassword) {
    log.warn('в системе нет пользователей, а ADMIN_LOGIN/ADMIN_PASSWORD не заданы: войти будет невозможно');
    return;
  }
  await deps.db
    .insert(users)
    .values({ login: adminLogin, passwordHash: await hashPassword(adminPassword), role: 'admin' })
    .onConflictDoNothing();
}
