#!/bin/sh
set -e

# Apply pending migrations before starting (safe to repeat; already-applied ones are skipped).
# Set RUN_MIGRATIONS=false where a separate release step runs them instead.
if [ "${RUN_MIGRATIONS:-true}" = "true" ]; then
  node dist/db/scripts/migrate.js
fi

exec node --enable-source-maps --import ./dist/instrument.js dist/main.js
