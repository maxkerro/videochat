import { createDb, createPool, type Database } from '../src/db/client.js';
import { resetDatabase, runMigrations } from '../src/db/migrate.js';

/** Integration suites run only when a test database and Redis are configured (locally and in CI). */
export const hasInfra = Boolean(process.env.TEST_DATABASE_URL && process.env.REDIS_URL);

/** Fresh, fully migrated test database. */
export async function freshDatabase(): Promise<{ db: Database; close: () => Promise<void> }> {
  const pool = createPool(process.env.TEST_DATABASE_URL!, 5);
  await resetDatabase(pool);
  await runMigrations(pool);
  return { db: createDb(pool), close: () => pool.end() };
}
