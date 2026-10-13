import { useEffect, useState } from 'react';
import { formatDuration } from './endMessage';

/** "m:ss" since `startedAt`, ticking every second; "" before the call is connected. A reading taken
 *  before the call connected is older than `startedAt`, which shows as 0:00 until the next tick. */
export function useCallTimer(startedAt: number | null): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [startedAt]);
  return startedAt === null ? '' : formatDuration(now - startedAt);
}
