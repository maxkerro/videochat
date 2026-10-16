import renderYaml from '../../../../render.yaml?raw';

/**
 * The web app calls the API on its own origin, and render.yaml proxies those paths to the API
 * (see the comment there). A path the web app calls without a proxy route gets index.html back
 * on staging/production -- which is how attachment URLs, search, presence and push silently
 * broke (found in CHAT-075). This checks every API path in the web app's code has a route.
 */

/** The app's own source (not tests), as text. */
const sources = import.meta.glob(['../**/*.{ts,tsx}', '!../**/*.test.{ts,tsx}', '!../test/**'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** First path segment of every API call: apiGet('/x/...'), fetch(`${API_URL}/x`), ... */
function calledSegments(): Set<string> {
  const segments = new Set<string>();
  const pattern =
    /(?:api(?:Get|Post|Put|Patch|Delete|Upload)\w*\(\s*|\$\{API_URL\})[`'"]?\/([a-z][a-z0-9-]*)/g;
  for (const text of Object.values(sources)) {
    for (const m of text.matchAll(pattern)) segments.add(m[1]!);
  }
  return segments;
}

function proxiedSegments(): Set<string> {
  const proxied = new Set<string>();
  for (const m of renderYaml.matchAll(
    /source: \/([a-z][a-z0-9-]*)(?:\/\*)?\s*\n\s*destination: https:\/\/videochat-api/g,
  )) {
    proxied.add(m[1]!);
  }
  return proxied;
}

describe('render.yaml proxies every API path the web app calls', () => {
  it('has a rewrite to the API for each', () => {
    const called = calledSegments();
    expect(called.size).toBeGreaterThan(5);
    const proxied = proxiedSegments();
    const missing = [...called].filter((s) => !proxied.has(s));
    expect(missing).toEqual([]);
  });
});
