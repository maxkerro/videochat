import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router';
import { CallBar } from './CallBar';
import { useCalls } from './CallProvider';
import { CallView } from './CallView';
import { IncomingCallDialog } from './IncomingCallDialog';
import { useCallShortcuts } from './useCallShortcuts';

/**
 * CHAT-042: whichever call UI fits right now -- the incoming-call dialog, the full call screen,
 * or the minimised bar. Rendered once in the app shell. Moving to a different chat minimises the
 * call instead of ending it.
 */
export function CallOverlay() {
  const calls = useCalls();
  const { call, expanded, setExpanded } = calls;
  const location = useLocation();
  useCallShortcuts(calls);

  const lastPath = useRef(location.pathname);
  useEffect(() => {
    if (lastPath.current === location.pathname) return;
    lastPath.current = location.pathname;
    if (call && call.phase !== 'incoming' && location.pathname !== `/c/${call.conversationId}`) {
      setExpanded(false);
    }
  }, [location.pathname, call, setExpanded]);

  if (!call || call.phase === 'ended') return null;
  if (call.phase === 'incoming') return <IncomingCallDialog key={call.callId} call={call} />;
  return expanded ? <CallView call={call} /> : <CallBar call={call} />;
}
