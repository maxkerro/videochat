import { loadEnv } from '../../config/env.js';
import { createDb, createPool } from '../client.js';
import { DEMO_PASSWORD, seedDemoData } from '../seed.js';

const env = loadEnv();
if (env.NODE_ENV === 'production') {
  console.error('Refusing to seed demo data into production.');
  process.exit(1);
}

const pool = createPool(env.DATABASE_URL, 1);
try {
  const result = await seedDemoData(createDb(pool));
  if (result.created) {
    console.log('Seeded demo data:');
    console.log('  users: anna, ben, clara (password: %s)', DEMO_PASSWORD);
    console.log('  direct chat: anna ↔ ben');
    console.log('  group chat: "Project Relay" (anna, ben, clara)');
  } else {
    console.log('Demo users already exist; nothing to do.');
  }
} finally {
  await pool.end();
}
