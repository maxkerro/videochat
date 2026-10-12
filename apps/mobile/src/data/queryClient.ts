import { QueryClient } from '@tanstack/react-query';
import { isNetworkError } from '../lib/errors';
import { session } from '../lib/api';
import { getLocalStore } from '../db/expoDb';

/** One query cache for the whole app. It is emptied (and the on-device copy wiped) when the session
 *  ends, so the next account never sees the previous one's chats. */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      gcTime: 10 * 60_000,
      // Offline is a normal state here: keep showing what we have rather than erroring.
      retry: (count, error) => !isNetworkError(error) && count < 1,
      networkMode: 'always',
    },
  },
});

// Registered once, for the life of the process (not tied to any screen): CHAT-053's "wipe the cache
// on sign-out" hook from CHAT-051.
session.onSignedOut(async () => {
  queryClient.clear();
  try {
    await (await getLocalStore()).wipe();
  } catch {
    // The wipe is best effort; the owner check on the next sign-in wipes a stale cache too.
  }
});

/** True while the session that started some work is still the current one. */
export const sameSession = (startedAt: number) => session.generation() === startedAt;
