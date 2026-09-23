import type { z } from 'zod';

export const API_URL =
  (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3000';

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
  const requestId = res.headers.get('x-request-id') ?? undefined;
  if (!res.ok && !init?.acceptStatuses?.includes(res.status)) {
    throw new ApiError(res.status, `Request to ${path} failed with ${res.status}`, requestId);
  }
  return schema.parse(await res.json());
}
