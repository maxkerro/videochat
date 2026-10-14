import { activeGroupCallResponseSchema, groupCallJoinSchema } from '@videochat/shared';
import { apiGet, apiPost } from '../lib/api';

/** CHAT-070: the call running in a group (null when none). */
export const fetchRunningGroupCall = (conversationId: string) =>
  apiGet(`/conversations/${conversationId}/group-call`, activeGroupCallResponseSchema);

/** CHAT-070: start the group's call or join the running one; returns where to connect. */
export const joinGroupCall = (conversationId: string) =>
  apiPost(`/conversations/${conversationId}/group-call`, groupCallJoinSchema);
