import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type pg from 'pg';
import { createDb } from './client.js';

/** Absolute path to the generated SQL migrations (apps/api/drizzle), from src/ or dist/. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

export async function runMigrations(pool: pg.Pool): Promise<void> {
  await migrate(createDb(pool), { migrationsFolder: MIGRATIONS_FOLDER });
}

/**
 * Drops everything the migrations created, returning the database to empty.
 * Drizzle migrations are forward-only; this is the "back" direction for dev and tests.
 * Never wired to production.
 */
export async function resetDatabase(pool: pg.Pool): Promise<void> {
  await pool.query(`
    DROP SCHEMA IF EXISTS public CASCADE;
    DROP SCHEMA IF EXISTS drizzle CASCADE;
    CREATE SCHEMA public;
  `);
}
