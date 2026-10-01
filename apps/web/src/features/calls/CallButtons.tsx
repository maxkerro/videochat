import type { CallMedia } from '@videochat/shared';
import { useState } from 'react';
import { Button } from '../../components/ui';
import type { CallPeer } from './CallEngine';
import { useCalls } from './CallProvider';
import { hasMediaSupport } from './mediaDevices';
import { PreJoinDialog } from './PreJoinDialog';
import styles from './Calls.module.css';

/** CHAT-042: the audio/video call buttons in a direct conversation's header. */
export function CallButtons({
  peer,
  conversationId,
  disabled = false,
}: {
  peer: CallPeer;
  conversationId: string;
  disabled?: boolean;
}) {
  const calls = useCalls();
  const [media, setMedia] = useState<CallMedia | null>(null);
  const inCall = calls.call !== null && calls.call.phase !== 'ended';
  const unavailable = disabled || inCall || !hasMediaSupport();
  const why = inCall ? ' (already in a call)' : '';

  return (
    <div className={styles.callButtons}>
      <Button
        variant="ghost"
        size="icon"
        aria-label={`Start audio call with ${peer.displayName}${why}`}
        title="Audio call"
        disabled={unavailable}
        onClick={() => setMedia('audio')}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.25 11.4 11.4 0 0 0 3.6.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1 11.4 11.4 0 0 0 .57 3.6 1 1 0 0 1-.25 1z"
            fill="currentColor"
          />
        </svg>
      </Button>
      <Button
        variant="ghost"
        size="icon"
        aria-label={`Start video call with ${peer.displayName}${why}`}
        title="Video call"
        disabled={unavailable}
        onClick={() => setMedia('video')}
      >
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M4 6h11a2 2 0 0 1 2 2v1.5l4-2.5v10l-4-2.5V16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z"
            fill="currentColor"
          />
        </svg>
      </Button>
      {media && (
        <PreJoinDialog
          open
          onOpenChange={(open) => {
            if (!open) setMedia(null);
          }}
          media={media}
          peer={peer}
          conversationId={conversationId}
        />
      )}
    </div>
  );
}
