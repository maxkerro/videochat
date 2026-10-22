import { loadEnv } from '../../config/env.js';
import { createDb, createPool } from '../client.js';
import { setModerator } from '../moderation.js';

/**
 * CHAT-077: give or take away moderator access (the moderation console).
 *
 *   pnpm --filter @videochat/api moderator grant anna@example.com
 *   pnpm --filter @videochat/api moderator revoke anna@example.com
 *
 * On Render (API service -> Shell): `node dist/db/scripts/moderator.js grant <email>`.
 */
const [command, email] = process.argv.slice(2);
if ((command !== 'grant' && command !== 'revoke') || !email) {
  console.error('Usage: moderator grant|revoke <email>');
  process.exit(1);
}
const env = loadEnv();
const pool = createPool(env.DATABASE_URL, 1);
try {
  const found = await setModerator(createDb(pool), email, command === 'grant');
  if (!found) {
    console.error(`No account with the email ${email}`);
    process.exitCode = 1;
  } else {
    console.log(
      command === 'grant' ? `${email} is now a moderator.` : `${email} is no longer a moderator.`,
    );
  }
} finally {
  await pool.end();
}
