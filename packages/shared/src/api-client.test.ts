import { z } from 'zod';
import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient, type ApiFetch, type ApiResponseLike } from './api-client.js';

const schema = z.object({ ok: z.boolean() });

function response(body: string, status = 200, headers: Record<string, string> = {}) {
  const res: ApiResponseLike = {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: () => Promise.resolve(body),
    clone: () => ({ json: () => Promise.resolve(JSON.parse(body) as unknown) }),
  };
  return res;
}

function client(fetchImpl: ApiFetch, extra: Partial<Parameters<typeof createApiClient>[0]> = {}) {
  return createApiClient({ baseUrl: 'https://api.test', fetch: fetchImpl, ...extra });
}

describe('createApiClient', () => {
  it('prefixes the base url, validates the body and sends JSON for posts', async () => {
    const fetchImpl = vi.fn<ApiFetch>().mockResolvedValue(response('{"ok":true}'));
    const { apiPost } = client(fetchImpl);
    await expect(apiPost('/x', schema, { a: 1 })).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledWith('https://api.test/x', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: '{"a":1}',
    });
  });

  it('applies defaults and async per-request headers; call headers win', async () => {
    const fetchImpl = vi.fn<ApiFetch>().mockResolvedValue(response('{"ok":true}'));
    const { apiGet } = client(fetchImpl, {
      defaults: { credentials: 'include' },
      getHeaders: () => Promise.resolve({ Authorization: 'Bearer a', 'X-Test': 'default' }),
    });
    await apiGet('/x', schema, { headers: { 'X-Test': 'call' } });
    expect(fetchImpl).toHaveBeenCalledWith('https://api.test/x', {
      credentials: 'include',
      headers: { Accept: 'application/json', Authorization: 'Bearer a', 'X-Test': 'call' },
    });
  });

  it('throws ApiError with status, request id and the API message', async () => {
    const fetchImpl = vi
      .fn<ApiFetch>()
      .mockResolvedValue(response('{"message":["a","b"]}', 400, { 'x-request-id': 'r1' }));
    const error = await client(fetchImpl)
      .apiGet('/x', schema)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 400, requestId: 'r1', message: 'a, b' });
  });

  it('treats an empty successful body as undefined and honours acceptStatuses', async () => {
    const empty = vi.fn<ApiFetch>().mockResolvedValue(response('', 201));
    await expect(client(empty).apiPost('/x', z.undefined())).resolves.toBeUndefined();
    const missing = vi.fn<ApiFetch>().mockResolvedValue(response('{"ok":false}', 404));
    await expect(client(missing).apiGet('/x', schema, { acceptStatuses: [404] })).resolves.toEqual({
      ok: false,
    });
  });

  it('sends uploads raw without a JSON content type, and a DELETE body as given', async () => {
    const fetchImpl = vi.fn<ApiFetch>().mockResolvedValue(response('{"ok":true}'));
    const { apiUpload, apiDelete } = client(fetchImpl);
    const form = { fake: 'form-data' };
    await apiUpload('/up', schema, form);
    expect(fetchImpl).toHaveBeenLastCalledWith('https://api.test/up', {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: form,
    });
    await apiDelete('/d', schema, { body: '{"e":1}', headers: { 'Content-Type': 'text/plain' } });
    expect(fetchImpl).toHaveBeenLastCalledWith('https://api.test/d', {
      method: 'DELETE',
      headers: { Accept: 'application/json', 'Content-Type': 'text/plain' },
      body: '{"e":1}',
    });
  });

  it('propagates network failures unwrapped', async () => {
    const fetchImpl = vi.fn<ApiFetch>().mockRejectedValue(new TypeError('Network request failed'));
    await expect(client(fetchImpl).apiGet('/x', schema)).rejects.toThrow('Network request failed');
  });
});
