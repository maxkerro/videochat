/** A Response body can only be read once, so a mock used for more than one fetch() call (e.g.
 *  AuthProvider's silent refresh on mount, plus whatever the test itself triggers) must build a
 *  fresh Response per call rather than resolving to one shared instance. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** vi.fn() that returns a fresh Response (built from `body`/`status`) on every call. */
export function fetchAlwaysReturning(body: unknown, status = 200) {
  return vi.fn(() => Promise.resolve(jsonResponse(body, status)));
}
