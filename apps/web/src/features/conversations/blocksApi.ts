import { blockedUsersListSchema, type BlockedUsersList } from '@videochat/shared';
import { z } from 'zod';
import { apiDelete, apiGet, apiPost } from '../../lib/api';

function authHeader(accessToken: string) {
  return { Authorization: `Bearer ${accessToken}` };
}

/** CHAT-021: block someone -- from a profile or a DM. Idempotent server-side, so calling this
 *  again for someone already blocked is harmless. */
export function blockUser(accessToken: string, targetUserId: string): Promise<void> {
  return apiPost(`/users/${targetUserId}/block`, z.object({ message: z.string() }), undefined, {
    headers: authHeader(accessToken),
  }).then(() => undefined);
}

/** CHAT-021: unblock. */
export function unblockUser(accessToken: string, targetUserId: string): Promise<void> {
  return apiDelete(`/users/${targetUserId}/block`, z.object({ message: z.string() }), {
    headers: authHeader(accessToken),
  }).then(() => undefined);
}

/** CHAT-021: the caller's own blocklist. */
export function fetchBlockedUsers(accessToken: string): Promise<BlockedUsersList> {
  return apiGet('/users/blocked', blockedUsersListSchema, { headers: authHeader(accessToken) });
}
