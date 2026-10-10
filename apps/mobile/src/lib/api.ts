import Constants from 'expo-constants';
import { createApiClient } from '@videochat/shared';
import { createSessionManager } from '../auth/session';
import { secureStoreStorage } from '../auth/storage';
import { parseConfig } from '../config';

export const config = parseConfig(Constants.expoConfig?.extra);

/** The signed-in session: tokens in the OS keystore, bearer header + refresh-and-retry on 401. */
export const session = createSessionManager({
  baseUrl: config.apiUrl,
  storage: secureStoreStorage,
});

/**
 * CHAT-050/051: the same typed client web uses (@videochat/shared), pointed at the API. There is
 * no cookie jar on mobile, so requests carry `Authorization: Bearer ...` through `authedFetch`.
 */
export const { apiGet, apiPost, apiPut, apiPatch, apiDelete, apiUpload } = createApiClient({
  baseUrl: config.apiUrl,
  fetch: session.authedFetch,
});

/** Calls that must work signed out (sign-up, password reset), so no bearer token is attached. */
export const publicApi = createApiClient({ baseUrl: config.apiUrl });
