import { z } from 'zod';
import { apiGet, apiPatch, apiPost, apiUpload, ApiError } from './api.js';

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

  it('surfaces the API-provided error message when the body has one', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(jsonResponse({ message: 'Invalid email or password' }, { status: 401 })),
    );
    await expect(apiGet('/thing', schema)).rejects.toThrow('Invalid email or password');
  });

  it('joins a Nest validation array into one message', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ message: ['email is required', 'password too short'] }, { status: 400 }),
        ),
    );
    await expect(apiGet('/thing', schema)).rejects.toThrow('email is required, password too short');
  });
});

describe('apiPost', () => {
  it('sends a JSON body and parses the response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }, { status: 201 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(apiPost('/thing', schema, { a: 1 })).resolves.toEqual({ ok: true });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('sends no body when none is given', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await apiPost('/thing', schema);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBeUndefined();
  });

  it('throws ApiError on a non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ message: 'nope' }, { status: 409 })),
    );
    await expect(apiPost('/thing', schema, {})).rejects.toMatchObject({ status: 409 });
  });
});

describe('apiPatch', () => {
  it('sends a PATCH request with a JSON body', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await apiPatch('/thing', schema, { a: 1 });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('PATCH');
  });
});

describe('apiUpload', () => {
  it('POSTs a FormData body without setting Content-Type', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const formData = new FormData();
    formData.append('avatar', new Blob(['x']), 'a.png');
    await apiUpload('/me/avatar', schema, formData);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe('POST');
    expect(init.body).toBe(formData);
    expect((init.headers as Record<string, string>)['Content-Type']).toBeUndefined();
  });
});
