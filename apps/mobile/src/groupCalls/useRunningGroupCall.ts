import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  GROUP_CALL_EVENTS,
  groupCallUpdatedSchema,
  type ActiveGroupCallResponse,
} from '@videochat/shared';
import { useEffect } from 'react';
import { subscribeRealtime } from '../realtime/connection';
import { fetchRunningGroupCall } from './groupCallsApi';

export const runningGroupCallKey = (conversationId: string) => ['group-call', conversationId];

/** CHAT-070: the call running in a group, kept live by `groupcall.updated`. */
export function useRunningGroupCall(conversationId: string, enabled: boolean) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: runningGroupCallKey(conversationId),
    queryFn: () => fetchRunningGroupCall(conversationId),
    enabled,
  });

  useEffect(() => {
    if (!enabled) return;
    return subscribeRealtime((envelope) => {
      if (envelope.type === 'realtime.ready') {
        // Updates may have been missed while the socket was down.
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
  }, [conversationId, enabled, queryClient]);

  return query.data?.call ?? null;
}
