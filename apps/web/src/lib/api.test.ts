import { z } from 'zod';
import { apiGet, ApiError } from './api.js';

const schema = z.object({ ok: z.boolean() });

function jsonResponse(body: unknown, init?: ResponseInit & { requestId?: string }) {
  const headers = new Headers(init?.headers);
  if (init?.requestId) headers.set('x-request-id', init.requestId);
  return new Response(JSON.stringify(body), { ...init, headers });
}

afterEach(() => vi.unstubAllGlobals());

describe('apiGet', () => {
  it('parses a successful response against the shared schema', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ok: true }, { status: 200 })));
    await expect(apiGet('/thing', schema)).resolves.toEqual({ ok: true });
  });

  it('throws an ApiError, carrying the status and request id, on a non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ ok: false }, { status: 500, requestId: 'req-42' })),
    );
    const error = await apiGet('/thing', schema).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 500, requestId: 'req-42' });
  });

  it('does not throw for a status listed in acceptStatuses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ ok: false }, { status: 404 })));
    await expect(apiGet('/thing', schema, { acceptStatuses: [404] })).resolves.toEqual({
      ok: false,
    });
  });

  it('propagates a network failure (e.g. server unreachable) unwrapped', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(apiGet('/thing', schema)).rejects.toThrow('Failed to fetch');
  });
});
