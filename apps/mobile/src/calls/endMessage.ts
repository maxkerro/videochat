import type { CallEndCause, CallSnapshot } from './CallEngine';

/** What to tell the person when a call ends, if anything. `null` = nothing worth saying. */
export function endMessage(
  call: Pick<CallSnapshot, 'direction' | 'peer' | 'startedAt'>,
  cause: CallEndCause,
  now: number,
): string | null {
  const name = call.peer.displayName;
  switch (cause) {
    case 'missed':
      return call.direction === 'outgoing' ? `${name} didn’t answer` : `Missed call from ${name}`;
    case 'declined':
      return call.direction === 'outgoing' ? `${name} declined the call` : null;
    case 'busy':
      return `${name} is on another call`;
    case 'unavailable':
      return `You can’t call ${name} right now`;
    case 'cancelled':
      return call.direction === 'incoming' ? `Missed call from ${name}` : null;
    case 'answered-elsewhere':
      return 'Answered on another device';
    case 'connection-lost':
    case 'failed':
      return 'The call was disconnected';
    case 'completed':
      return call.startedAt !== null
        ? `Call ended · ${formatDuration(now - call.startedAt)}`
        : 'Call ended';
  }
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(h > 0 ? 2 : 1, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
