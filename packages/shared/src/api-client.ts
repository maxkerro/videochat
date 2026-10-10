import type { z } from 'zod';

/**
 * CHAT-050: the platform-neutral half of the typed API client. Web and mobile both build their
 * `apiGet`/`apiPost`/... from {@link createApiClient}, so the response validation, error
 * mapping and empty-body handling live in one place. The two platforms differ only in how a
 * request is authenticated: web sends the refresh cookie (`credentials: 'include'`), mobile
 * sends an `Authorization` header and keeps its tokens in the OS keystore.
 *
 * The shared package is compiled without the DOM lib, so the fetch types below are minimal
 * structural ones -- any WHATWG `fetch` (browser, Node 22, React Native) satisfies them.
 */

export interface ApiResponseLike {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  clone(): { json(): Promise<unknown> };
}

export interface ApiRequestInit {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  signal?: unknown;
  credentials?: 'include' | 'omit' | 'same-origin';
}

export type ApiFetch = (url: string, init: ApiRequestInit) => Promise<ApiResponseLike>;

/** Per-call options. A `body` here is sent as-is (already serialized), for the rare DELETE with
 *  a payload; JSON bodies go through the `body` argument of apiPost/apiPut/apiPatch. */
export type ApiRequestOptions = Omit<ApiRequestInit, 'method'> & {
  acceptStatuses?: number[];
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Nest's default error body is `{ statusCode, message, error }`; message can be a string
 *  (one error) or a string array (multiple validation errors). Falls back to a generic
 *  message when the body isn't JSON or has no `message` field. */
async function errorMessage(res: ApiResponseLike): Promise<string> {
  try {
    const body: unknown = await res.clone().json();
    const message = (body as { message?: unknown } | null)?.message;
    if (typeof message === 'string') return message;
    if (Array.isArray(message) && message.every((m) => typeof m === 'string')) {
      return message.join(', ');
    }
  } catch {
    // Not JSON, or no message field -- fall through to the generic message below.
  }
  return `Request failed with status ${res.status}`;
}

async function handleResponse<S extends z.ZodType>(
  res: ApiResponseLike,
  schema: S,
  acceptStatuses?: number[],
): Promise<z.infer<S>> {
  const requestId = res.headers.get('x-request-id') ?? undefined;
  if (!res.ok && !acceptStatuses?.includes(res.status)) {
    throw new ApiError(res.status, await errorMessage(res), requestId);
  }
  // A 204, or any other successful response Nest sends with an empty body (CHAT-018's
  // `Promise<void>` endpoints answer 200/201 with `Content-Length: 0`, not 204) -- `JSON.parse`
  // on an empty body throws, so this checks for that directly instead of guessing status codes.
  const text = await res.text();
  if (text.length === 0) return schema.parse(undefined);
  return schema.parse(JSON.parse(text));
}

export interface ApiClientOptions {
  /** Prepended to every path. Empty string means same-origin relative paths (web in production). */
  baseUrl: string;
  /** Defaults to the global `fetch`, looked up on every call so tests can stub it. */
  fetch?: ApiFetch;
  /** Applied to every request: web passes `{ credentials: 'include' }`. */
  defaults?: ApiRequestInit;
  /** Extra headers per request, e.g. mobile's `Authorization: Bearer ...`. */
  getHeaders?: () => Record<string, string> | Promise<Record<string, string>>;
}

export function createApiClient(options: ApiClientOptions) {
  async function request<S extends z.ZodType>(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    schema: S,
    body: unknown,
    init: ApiRequestOptions | undefined,
    raw = false,
  ): Promise<z.infer<S>> {
    const doFetch: ApiFetch =
      options.fetch ?? ((url, i) => (globalThis as unknown as { fetch: ApiFetch }).fetch(url, i));
    const { acceptStatuses, headers: initHeaders, body: initBody, ...rest } = init ?? {};
    const hasJsonBody = !raw && body !== undefined;
    const res = await doFetch(`${options.baseUrl}${path}`, {
      ...options.defaults,
      ...(method === 'GET' ? {} : { method }),
      ...rest,
      headers: {
        Accept: 'application/json',
        ...(hasJsonBody ? { 'Content-Type': 'application/json' } : {}),
        ...(await options.getHeaders?.()),
        ...initHeaders,
      },
      ...(body !== undefined
        ? { body: raw ? body : JSON.stringify(body) }
        : initBody !== undefined
          ? { body: initBody }
          : {}),
    });
    return handleResponse(res, schema, acceptStatuses);
  }

  return {
    apiGet: <S extends z.ZodType>(path: string, schema: S, init?: ApiRequestOptions) =>
      request('GET', path, schema, undefined, init),
    apiPost: <S extends z.ZodType>(
      path: string,
      schema: S,
      body?: unknown,
      init?: ApiRequestOptions,
    ) => request('POST', path, schema, body, init),
    apiPut: <S extends z.ZodType>(
      path: string,
      schema: S,
      body?: unknown,
      init?: ApiRequestOptions,
    ) => request('PUT', path, schema, body, init),
    apiPatch: <S extends z.ZodType>(
      path: string,
      schema: S,
      body?: unknown,
      init?: ApiRequestOptions,
    ) => request('PATCH', path, schema, body, init),
    apiDelete: <S extends z.ZodType>(path: string, schema: S, init?: ApiRequestOptions) =>
      request('DELETE', path, schema, undefined, init),
    /** POST a `multipart/form-data` body. Never set Content-Type yourself -- the runtime adds
     *  the multipart boundary when it isn't present. */
    apiUpload: <S extends z.ZodType>(
      path: string,
      schema: S,
      formData: unknown,
      init?: ApiRequestOptions,
    ) => request('POST', path, schema, formData, init, true),
  };
}
