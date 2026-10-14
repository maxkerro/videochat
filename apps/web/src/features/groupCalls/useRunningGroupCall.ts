import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  GROUP_CALL_EVENTS,
  groupCallParticipantsText,
  groupCallUpdatedSchema,
  type ActiveGroupCallResponse,
  type GroupCall,
} from '@videochat/shared';
import { useAuth, withAuthRetry } from '../auth/AuthContext';
import { useRealtimeEvent } from '../chat/RealtimeProvider';
import { fetchRunningGroupCall } from './groupCallsApi';

export const runningGroupCallKey = (conversationId: string) => ['group-call', conversationId];

/** CHAT-070: the call running in a group, kept live by `groupcall.updated`. */
export function useRunningGroupCall(conversationId: string | undefined, enabled: boolean) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: runningGroupCallKey(conversationId ?? ''),
    queryFn: () => withAuthRetry(auth, (token) => fetchRunningGroupCall(token, conversationId!)),
    enabled: enabled && Boolean(conversationId),
  });

  useRealtimeEvent((envelope) => {
    if (!conversationId || !enabled) return;
    if (envelope.type === 'realtime.ready') {
      // Missed updates while offline: ask again.
      void queryClient.invalidateQueries({ queryKey: runningGroupCallKey(conversationId) });
      return;
    }
    if (envelope.type !== GROUP_CALL_EVENTS.updated) return;
    const update = groupCallUpdatedSchema.safeParse(envelope.payload);
    if (!update.success || update.data.conversationId !== conversationId) return;
    queryClient.setQueryData<ActiveGroupCallResponse>(runningGroupCallKey(conversationId), {
      call: update.data.call,
    });
  });

  return query.data?.call ?? null;
}

export const participantsText = (call: GroupCall) =>
  groupCallParticipantsText(call.participantCount);
