/** A fetch that never got an answer (no network, DNS, or our own timeout). React Native and
 *  browsers raise these as a TypeError; our timeout aborts with an AbortError (a DOMException,
 *  which isn't an Error subclass everywhere). Other TypeErrors are programming bugs and must not
 *  look like "offline". */
export function isNetworkError(e: unknown): boolean {
  if ((e as { name?: unknown } | null)?.name === 'AbortError') return true;
  return (
    e instanceof TypeError &&
    /network|failed to fetch|internet|connection|timed? ?out|offline/i.test(e.message)
  );
}

/** A file that can't be sent (too big, unreadable), or whose upload to storage failed. The message
 *  is already worded for the person. */
export class UploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UploadError';
  }
}
