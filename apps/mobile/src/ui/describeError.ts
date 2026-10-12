import { ApiError } from '@videochat/shared';
import { ZodError } from 'zod';
import { isNetworkError } from '../lib/errors';

const UNEXPECTED_RESPONSE =
  'The server answered, but not in the format this app expects. The server may need to be updated.';

/** A message for the person, not a stack trace -- and one that doesn't call every failure a
 *  connection problem: a server that answers with something the app doesn't understand (an API
 *  older than this build, or an HTML page from a wrong host) is a different problem from having
 *  no network, and a programming bug is neither. */
export function describeError(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (isNetworkError(e)) return 'Can’t reach the server. Check your connection.';
  // ZodError: valid JSON of the wrong shape. SyntaxError: not JSON at all.
  if (e instanceof ZodError || e instanceof SyntaxError) return UNEXPECTED_RESPONSE;
  return e instanceof Error ? `Something went wrong: ${e.message}` : 'Something went wrong.';
}
