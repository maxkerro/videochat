import { useEffect, useState } from 'react';

function isVisible(): boolean {
  // No `document` at all (SSR, some test setups): default to visible rather than assuming
  // hidden, since there's nothing here that would ever flip it back.
  return typeof document === 'undefined' || document.visibilityState === 'visible';
}

/**
 * CHAT-019: tracks whether the tab is currently visible, via the standard
 * `visibilitychange` event. Read receipts must not be sent while the tab is hidden (an AC of
 * "read receipts and unread state") -- this is the single place that decision is made, so
 * `ChatPane`'s read-tracking effect (and anything else that ever needs the same gate) can just
 * check a boolean rather than each wiring up its own listener.
 */
export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(isVisible);

  useEffect(() => {
    function handleChange() {
      setVisible(isVisible());
    }
    document.addEventListener('visibilitychange', handleChange);
    // The state right after mount could already be stale (visibility changed between the
    // `useState` initializer running and this listener being attached) -- re-check once here
    // rather than trusting the initializer's snapshot for the entire mount.
    handleChange();
    return () => document.removeEventListener('visibilitychange', handleChange);
  }, []);

  return visible;
}
