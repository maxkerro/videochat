import {
  activeGroupCallResponseSchema,
  groupCallJoinSchema,
  type ActiveGroupCallResponse,
  type GroupCallJoin,
} from '@videochat/shared';
import { apiGet, apiPost } from '../../lib/api';

const auth = (accessToken: string) => ({ headers: { Authorization: `Bearer ${accessToken}` } });

/** CHAT-070: the call running in a group (null when none). */
export function fetchRunningGroupCall(
  accessToken: string,
  conversationId: string,
): Promise<ActiveGroupCallResponse> {
  return apiGet(
    `/conversations/${conversationId}/group-call`,
    activeGroupCallResponseSchema,
    auth(accessToken),
  );
}

/** CHAT-070: start the group's call or join the running one; returns where to connect. */
export function joinGroupCall(accessToken: string, conversationId: string): Promise<GroupCallJoin> {
  return apiPost(
    `/conversations/${conversationId}/group-call`,
    groupCallJoinSchema,
    undefined,
    auth(accessToken),
  );
}
