import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;
/** A database handle or an open transaction; helpers accept either. */
export type DbExecutor = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

export function createPool(connectionString: string, max = 10): pg.Pool {
  return new pg.Pool({
    connectionString,
    max,
    idleTimeoutMillis: 30_000,
    // Unset, pg's default is 0 -- wait forever for a client when the pool is at `max` and every
    // connection is checked out. That turned a real pool-exhaustion bug into an opaque 20s vitest
    // testTimeout (or an outright hang) with no indication *why* the request never got a
    // response. Failing fast here instead surfaces pg's own
    // "timeout exceeded when trying to connect" error immediately, which is far cheaper to
    // diagnose than a generic test timeout, in production and in tests alike.
    connectionTimeoutMillis: 5_000,
  });
}

export function createDb(pool: pg.Pool): Database {
  return drizzle(pool, { schema });
}

export { schema };
