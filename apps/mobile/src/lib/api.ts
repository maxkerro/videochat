import Constants from 'expo-constants';
import { createApiClient } from '@videochat/shared';
import { parseConfig } from '../config';

export const config = parseConfig(Constants.expoConfig?.extra);

/**
 * CHAT-050: the same typed client web uses (@videochat/shared), pointed at the API. There is no
 * cookie jar on mobile, so no `credentials`; CHAT-051 adds the `Authorization` header via
 * `getHeaders` and keeps the tokens in the OS keystore.
 */
export const { apiGet, apiPost, apiPut, apiPatch, apiDelete, apiUpload } = createApiClient({
  baseUrl: config.apiUrl,
});
