import type { z } from 'zod';

/**
 * Base URL prepended to every API path. Empty string means "same origin, relative path" --
 * the setup in production, where the web static site proxies /auth, /me, /users, /health and
 * /ready through to the API (see render.yaml) so the refresh-token cookie is same-site rather
 * than cross-site between two *.onrender.com hosts. Local dev overrides this via .env to point
 * straight at the API's own port, since there's no proxy running locally.
 */
export const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? '';

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
async function errorMessage(res: Response): Promise<string> {
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
  res: Response,
  schema: S,
  acceptStatuses?: number[],
): Promise<z.infer<S>> {
  const requestId = res.headers.get('x-request-id') ?? undefined;
  if (!res.ok && !acceptStatuses?.includes(res.status)) {
    throw new ApiError(res.status, await errorMessage(res), requestId);
  }
  if (res.status === 204) return schema.parse(undefined);
  return schema.parse(await res.json());
}

/**
 * Typed fetch: validates the response with a shared Zod schema from @videochat/shared,
 * so a contract mismatch between web and API fails loudly instead of rendering garbage.
 */
export async function apiGet<S extends z.ZodType>(
  path: string,
  schema: S,
  init?: RequestInit & { acceptStatuses?: number[] },
): Promise<z.infer<S>> {
  const res = await fetch(`${API_URL}${path}`, {
    credentials: 'include',
    ...init,
    headers: { Accept: 'application/json', ...init?.headers },
  });
  return handleResponse(res, schema, init?.acceptStatuses);
}

/** POST/PATCH/DELETE with a JSON body, validated the same way as {@link apiGet}. */
async function apiSend<S extends z.ZodType>(
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  schema: S,
  body?: unknown,
  init?: RequestInit & { acceptStatuses?: number[] },
): Promise<z.infer<S>> {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    credentials: 'include',
    ...init,
    headers: {
      Accept: 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
    body: body !== undefined ? JSON.stringify(body) : init?.body,
  });
  return handleResponse(res, schema, init?.acceptStatuses);
}

export const apiPost = <S extends z.ZodType>(
  path: string,
  schema: S,
  body?: unknown,
  init?: RequestInit & { acceptStatuses?: number[] },
): Promise<z.infer<S>> => apiSend('POST', path, schema, body, init);

export const apiPatch = <S extends z.ZodType>(
  path: string,
  schema: S,
  body?: unknown,
  init?: RequestInit & { acceptStatuses?: number[] },
): Promise<z.infer<S>> => apiSend('PATCH', path, schema, body, init);

/** POST a `multipart/form-data` body (e.g. a file upload). Never set Content-Type yourself --
 *  the browser adds the multipart boundary when it isn't present. */
export async function apiUpload<S extends z.ZodType>(
  path: string,
  schema: S,
  formData: FormData,
  init?: RequestInit & { acceptStatuses?: number[] },
): Promise<z.infer<S>> {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    credentials: 'include',
    ...init,
    headers: { Accept: 'application/json', ...init?.headers },
    body: formData,
  });
  return handleResponse(res, schema, init?.acceptStatuses);
}
