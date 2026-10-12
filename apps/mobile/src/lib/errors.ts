/** A fetch that never got an answer (no network, timeout, DNS). React Native and browsers raise
 *  these as a TypeError; other TypeErrors are programming bugs and must not look like "offline". */
export function isNetworkError(e: unknown): boolean {
  return (
    e instanceof TypeError &&
    /network|failed to fetch|internet|connection|timed? ?out|offline/i.test(e.message)
  );
}
