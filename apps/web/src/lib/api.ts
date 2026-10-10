import { ApiError, createApiClient } from '@videochat/shared';

/**
 * Base URL prepended to every API path. Empty string means "same origin, relative path" --
 * the setup in production, where the web static site proxies /auth, /me, /users, /health and
 * /ready through to the API (see render.yaml) so the refresh-token cookie is same-site rather
 * than cross-site between two *.onrender.com hosts. Local dev overrides this via .env to point
 * straight at the API's own port, since there's no proxy running locally.
 */
export const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? '';

export { ApiError };

/**
 * CHAT-050: the request/validation logic now lives in @videochat/shared (so the mobile app
 * reuses it unchanged); web only supplies what is web-specific -- the base URL and the refresh
 * cookie (`credentials: 'include'`).
 */
export const { apiGet, apiPost, apiPut, apiPatch, apiDelete, apiUpload } = createApiClient({
  baseUrl: API_URL,
  defaults: { credentials: 'include' },
});
