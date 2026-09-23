import { loadEnv } from '../../config/env.js';
import { createPool } from '../client.js';
import { resetDatabase, runMigrations } from '../migrate.js';

const env = loadEnv();
if (env.NODE_ENV === 'production') {
  console.error('Refusing to reset a production database.');
  process.exit(1);
}

const pool = createPool(env.DATABASE_URL, 1);
try {
  await resetDatabase(pool);
  console.log('Database emptied.');
  if (!process.argv.includes('--empty')) {
    await runMigrations(pool);
    console.log('Migrations re-applied. Run `pnpm db:seed` for demo data.');
  }
} finally {
  await pool.end();
}
