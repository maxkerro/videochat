import { useEffect, useState } from 'react';
import { formatDuration } from './CallProvider';

/** "03:21" since `startedAt`, re-rendering once a second; null before the call connects. */
export function useCallTimer(startedAt: number | null): string | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  return startedAt === null ? null : formatDuration(now - startedAt);
}
