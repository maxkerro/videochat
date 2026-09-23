import { loadEnv } from '../../config/env.js';
import { createPool } from '../client.js';
import { MIGRATIONS_FOLDER, runMigrations } from '../migrate.js';

const env = loadEnv();
const pool = createPool(env.DATABASE_URL, 1);
try {
  console.log(`Applying migrations from ${MIGRATIONS_FOLDER}`);
  await runMigrations(pool);
  console.log('Migrations applied.');
} finally {
  await pool.end();
}
