import { useIsFocused } from 'expo-router';
import { useCallback, useEffect, useRef } from 'react';
import { useAppActive } from '../data/useLive';
import { dismissConversationNotifications } from '../push/notifications';
import { reportViewing, sendTypingSignal } from './connection';

/** The typing signal is sent at most this often while someone keeps typing. */
export const TYPING_THROTTLE_MS = 3_000;

/** While this conversation is on screen and the app is in front, the server knows not to push a
 *  notification for it. */
export function useViewingReporter(conversationId: string): void {
  const focused = useIsFocused();
  const active = useAppActive();
  const viewing = focused && active;
  useEffect(() => {
    if (!viewing) return;
    reportViewing(conversationId);
    void dismissConversationNotifications(conversationId);
    return () => reportViewing(null);
  }, [conversationId, viewing]);
}

/** Call the returned function on every keystroke; it sends "typing…" about every 3 s. */
export function useTypingSender(conversationId: string): () => void {
  const last = useRef(0);
  return useCallback(() => {
    const now = Date.now();
    if (now - last.current < TYPING_THROTTLE_MS) return;
    last.current = now;
    sendTypingSignal(conversationId);
  }, [conversationId]);
}

export { useRealtimeStatus } from './status';
