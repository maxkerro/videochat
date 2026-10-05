import { useEffect } from 'react';
import { useRealtime } from '../chat/RealtimeProvider';

/**
 * CHAT-035: tells the server which conversation this tab is showing while it's visible and
 * focused (null otherwise), so it doesn't push notifications for what's already on screen. Re-sent
 * after every reconnect, since the server forgets a connection's state when it closes.
 */
export function useViewingReporter(conversationId: string | undefined): void {
  const realtime = useRealtime();
  useEffect(() => {
    const report = () => {
      const active =
        document.visibilityState === 'visible' &&
        (typeof document.hasFocus !== 'function' || document.hasFocus());
      realtime.send('client.viewing', { conversationId: active ? (conversationId ?? null) : null });
    };
    report();
    const unsubscribe = realtime.subscribeStatus((status) => {
      if (status === 'open') report();
    });
    window.addEventListener('focus', report);
    window.addEventListener('blur', report);
    document.addEventListener('visibilitychange', report);
    return () => {
      unsubscribe();
      window.removeEventListener('focus', report);
      window.removeEventListener('blur', report);
      document.removeEventListener('visibilitychange', report);
      realtime.send('client.viewing', { conversationId: null });
    };
  }, [realtime, conversationId]);
}
