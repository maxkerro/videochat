/** Postgres error code for a unique-constraint violation. */
const UNIQUE_VIOLATION = '23505';

/**
 * True for a Postgres unique-constraint violation (error code 23505), however it got here --
 * node-postgres throws a plain object with a `.code` string, not a typed error class.
 *
 * Use this to turn a race that slips past an application-level "is it taken?" check (two
 * concurrent signups with the same email, two concurrent profile updates to the same username)
 * into a 409 Conflict instead of an unhandled 500: the check-then-insert/update pattern used
 * throughout this codebase is inherently racy, and the unique index is the actual source of
 * truth -- this just makes losing that race look like the same conflict the check was meant to
 * catch.
 */
export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === UNIQUE_VIOLATION
  );
}
