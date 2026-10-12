import { ApiError } from '@videochat/shared';
import { ZodError } from 'zod';

/** A message for the person, not a stack trace -- and one that doesn't call every failure a
 *  connection problem: a server that answers with something the app doesn't understand (an API
 *  that is older than this build) is a different problem from having no network. */
export function describeError(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof ZodError) {
    return 'The server answered, but not in the format this app expects. The server may need to be updated.';
  }
  if (e instanceof TypeError) return 'Can’t reach the server. Check your connection.';
  return e instanceof Error ? e.message : 'Something went wrong.';
}
