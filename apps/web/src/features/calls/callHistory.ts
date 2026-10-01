import type { CallMessageMeta } from '@videochat/shared';
import { formatDuration } from './CallProvider';

/**
 * CHAT-044: one call-history message, worded for whoever is reading it -- the caller and the
 * callee see the same call differently ("No answer" vs "Missed video call").
 */
export function callHistoryText(meta: CallMessageMeta, myUserId: string | undefined): string {
  const kind = meta.media === 'video' ? 'video call' : 'audio call';
  const Kind = kind[0]!.toUpperCase() + kind.slice(1);
  const iCalled = meta.callerId === myUserId;
  switch (meta.outcome) {
    case 'completed':
      return meta.durationSec !== null && meta.durationSec > 0
        ? `${Kind} · ${formatDuration(meta.durationSec * 1000)}`
        : Kind;
    case 'declined':
      return iCalled ? `${Kind} · Declined` : `Declined ${kind}`;
    case 'missed':
      if (!iCalled) return `Missed ${kind}`;
      if (meta.endReason === 'cancelled') return `Cancelled ${kind}`;
      if (meta.endReason === 'busy') return `${Kind} · Busy`;
      return `${Kind} · No answer`;
  }
}

/** True when this entry is a call the reader missed (shown with emphasis). */
export function isMissedByMe(meta: CallMessageMeta, myUserId: string | undefined): boolean {
  return meta.outcome === 'missed' && meta.callerId !== myUserId;
}
