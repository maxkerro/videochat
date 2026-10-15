import {
  addMembersSchema,
  attachmentUploadSchema,
  attachmentUrlSchema,
  blockedUsersListSchema,
  conversationSummarySchema,
  conversationsListSchema,
  createGroupConversationSchema,
  markConversationReadSchema,
  meSchema,
  membersListSchema,
  messagePageSchema,
  messageReactionsSchema,
  messageSchema,
  renameConversationSchema,
  reportMessageSchema,
  searchResponseSchema,
  sendMessageSchema,
  startDirectConversationSchema,
  updateProfileSchema,
  userSearchResultsSchema,
  REFRESH_MODE_HEADER,
  type AddMembersInput,
  type AttachmentUpload,
  type ChangePasswordInput,
  type CreateAttachmentUploadInput,
  type CreateGroupConversationInput,
  type ReportMessageInput,
  type SearchQuery,
  type SendMessageInput,
  type UpdateProfileInput,
  type UpdateSettingsInput,
} from '@videochat/shared';
import { z } from 'zod';
import { UploadError } from '../lib/errors';
import { queryString } from './search';
import { apiDelete, apiGet, apiPatch, apiPost, apiPut, apiUpload, session } from '../lib/api';

// Conversations ------------------------------------------------------------------------------

export const fetchConversations = () => apiGet('/conversations', conversationsListSchema);

export const fetchConversation = (id: string) =>
  apiGet(`/conversations/${id}`, conversationSummarySchema);

export const searchUsers = (query: string) =>
  apiGet(`/users/search?q=${encodeURIComponent(query)}`, userSearchResultsSchema);

export function startDirectConversation(userId: string) {
  const input = startDirectConversationSchema.parse({ userId });
  return apiPost('/conversations/direct', conversationSummarySchema, input);
}

export function createGroupConversation(input: CreateGroupConversationInput) {
  return apiPost(
    '/conversations/group',
    conversationSummarySchema,
    createGroupConversationSchema.parse(input),
  );
}

export const fetchMembers = (id: string) =>
  apiGet(`/conversations/${id}/members`, membersListSchema);

export function renameConversation(id: string, title: string) {
  return apiPatch(
    `/conversations/${id}`,
    conversationSummarySchema,
    renameConversationSchema.parse({ title }),
  );
}

export function addMembers(id: string, input: AddMembersInput) {
  return apiPost(
    `/conversations/${id}/members`,
    conversationSummarySchema,
    addMembersSchema.parse(input),
  );
}

export const removeMember = (id: string, userId: string) =>
  apiDelete(`/conversations/${id}/members/${userId}`, z.undefined());

export const leaveConversation = (id: string) =>
  apiPost(`/conversations/${id}/leave`, z.undefined());

export function markConversationRead(id: string, seq: number) {
  return apiPost(
    `/conversations/${id}/read`,
    conversationSummarySchema,
    markConversationReadSchema.parse({ seq }),
  );
}

export const markConversationUnread = (id: string) =>
  apiPost(`/conversations/${id}/unread`, conversationSummarySchema);

export const setConversationMuted = (id: string, muted: boolean) =>
  apiPut(`/conversations/${id}/mute`, conversationSummarySchema, { muted });

// Messages -----------------------------------------------------------------------------------

/** `before`: the `seq` of the oldest message already loaded. Omit it for the newest page.
 *  `limit`: a bigger page, for jumping far back to a search result (CHAT-072). */
export function fetchMessages(conversationId: string, before?: number, limit?: number) {
  const query = queryString({ before, limit });
  return apiGet(`/conversations/${conversationId}/messages${query}`, messagePageSchema);
}

/** CHAT-072: search the messages and files of every conversation you're in. */
export function searchMessages(query: SearchQuery) {
  return apiGet(`/search${queryString({ ...query })}`, searchResponseSchema);
}

/** `clientMsgId` makes a retry safe: the server returns the original instead of a duplicate. */
export function sendMessage(conversationId: string, input: SendMessageInput) {
  return apiPost(
    `/conversations/${conversationId}/messages`,
    messageSchema,
    sendMessageSchema.parse(input),
  );
}

export const editMessage = (conversationId: string, messageId: string, body: string) =>
  apiPatch(`/conversations/${conversationId}/messages/${messageId}`, messageSchema, { body });

export const deleteMessage = (conversationId: string, messageId: string) =>
  apiDelete(`/conversations/${conversationId}/messages/${messageId}`, messageSchema);

export const toggleReaction = (conversationId: string, messageId: string, emoji: string) =>
  apiPost(
    `/conversations/${conversationId}/messages/${messageId}/reactions`,
    messageReactionsSchema,
    { emoji },
  );

// Attachments --------------------------------------------------------------------------------

export const requestUpload = (conversationId: string, input: CreateAttachmentUploadInput) =>
  apiPost(`/conversations/${conversationId}/attachments`, attachmentUploadSchema, input);

export const fetchAttachmentUrl = (attachmentId: string, variant: 'original' | 'thumb') =>
  apiGet(`/attachments/${attachmentId}/url?variant=${variant}`, attachmentUrlSchema);

/** Object storage answers failures with XML like `<Code>SignatureDoesNotMatch</Code>`; showing the
 *  code turns a bare "403" into something diagnosable (wrong headers, expired URL, bad key...). */
export function storageErrorCode(body: string | null | undefined): string {
  const code = /<Code>([A-Za-z0-9_.-]{1,64})<\/Code>/.exec(body ?? '')?.[1];
  return code ? `: ${code}` : '';
}

/** PUTs a file straight to object storage through the signed URL (never through the API).
 *  XMLHttpRequest rather than fetch, for upload progress. */
export function uploadToStorage(
  upload: Pick<AttachmentUpload, 'uploadUrl' | 'uploadHeaders'>,
  file: Blob,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', upload.uploadUrl);
    for (const [name, value] of Object.entries(upload.uploadHeaders)) {
      xhr.setRequestHeader(name, value);
    }
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(e.loaded / e.total);
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(
            new UploadError(
              `Upload failed (${xhr.status}${storageErrorCode(xhr.responseText)})`,
              isRetryableStorageStatus(xhr.status),
            ),
          );
    xhr.onerror = () => reject(new UploadError('Upload failed -- check your connection', true));
    xhr.onabort = () => reject(new UploadError('Upload cancelled'));
    if (signal) {
      if (signal.aborted) return reject(new UploadError('Upload cancelled'));
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }
    xhr.send(file);
  });
}

/** A signed link that expired (403), a slow or overloaded storage node, or throttling is worth a
 *  fresh attempt with a new link; a rejected request (400, 413 ...) is not. */
export function isRetryableStorageStatus(status: number): boolean {
  return status === 0 || status === 403 || status === 408 || status === 429 || status >= 500;
}

/** CHAT-058: report someone else's message. */
export const reportMessage = (
  conversationId: string,
  messageId: string,
  input: ReportMessageInput,
) =>
  apiPost(
    `/conversations/${conversationId}/messages/${messageId}/report`,
    z.undefined(),
    reportMessageSchema.parse(input),
  );

// Profile, settings, blocking ---------------------------------------------------------------

export const fetchMe = () => apiGet('/me', meSchema);

export const updateProfile = (input: UpdateProfileInput) =>
  apiPatch('/me', meSchema, updateProfileSchema.parse(input));

/** React Native's FormData takes a `{ uri, name, type }` file descriptor. */
export function uploadAvatar(file: { uri: string; name: string; type: string }) {
  const form = new FormData();
  form.append('avatar', file as unknown as Blob);
  return apiUpload('/me/avatar', meSchema, form);
}

export const updateSettings = (input: UpdateSettingsInput) =>
  apiPatch('/me/settings', meSchema, input);

/** Mobile sessions have no cookie, so the API needs the refresh token in the body to know which
 *  session to keep when it revokes the others (CHAT-051). */
export async function changePassword(input: ChangePasswordInput) {
  const refreshToken = await session.currentRefreshToken();
  return apiPost(
    '/auth/change-password',
    z.unknown(),
    { ...input, refreshToken },
    { headers: { [REFRESH_MODE_HEADER]: 'body' } },
  );
}

export const fetchBlockedUsers = () => apiGet('/users/blocked', blockedUsersListSchema);

const messageResponse = z.object({ message: z.string() });
export const blockUser = (userId: string) => apiPost(`/users/${userId}/block`, messageResponse);
export const unblockUser = (userId: string) => apiDelete(`/users/${userId}/block`, messageResponse);

// Push notifications (CHAT-055) --------------------------------------------------------------

export async function registerPushDevice(platform: 'android' | 'ios', token: string) {
  // The refresh token names this login session, so the server ends the registration with it.
  const refreshToken = await session.currentRefreshToken();
  if (!refreshToken) throw new Error('Not signed in');
  return apiPost('/push/devices', z.undefined(), { platform, token, refreshToken });
}

export const unregisterPushDevice = (token: string) =>
  apiDelete('/push/devices', z.undefined(), {
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
