import { count } from 'drizzle-orm';
import { users } from '../../db/schema';
import type { AppDeps } from '../../deps';
import { hashPassword } from './password';

export async function ensureAdmin(deps: AppDeps): Promise<void> {
  const { adminLogin, adminPassword } = deps.config;
  if (!adminLogin || !adminPassword) return;
  const [r] = await deps.db.select({ n: count() }).from(users);
  if (r && r.n > 0) return;
  await deps.db
    .insert(users)
    .values({ login: adminLogin, passwordHash: await hashPassword(adminPassword), role: 'admin' })
    .onConflictDoNothing();
}
