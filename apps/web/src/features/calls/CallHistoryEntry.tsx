import type { Message } from '@videochat/shared';
import { useState } from 'react';
import { cx } from '../../lib/cx';
import type { CallPeer } from './CallEngine';
import { useCalls } from './CallProvider';
import { callHistoryText, isMissedByMe } from './callHistory';
import { hasMediaSupport } from './mediaDevices';
import { PreJoinDialog } from './PreJoinDialog';
import styles from './Calls.module.css';

/**
 * CHAT-044: a call in the conversation history. "Call back" starts a call of the same type
 * (audio or video), through the same pre-join check as the header buttons.
 */
export function CallHistoryEntry({
  message,
  myUserId,
  peer,
  time,
}: {
  message: Message;
  myUserId: string | undefined;
  /** The other person in the direct conversation; without one there's nobody to call back. */
  peer: CallPeer | null;
  time: string;
}) {
  const calls = useCalls();
  const [calling, setCalling] = useState(false);
  const meta = message.call;
  if (!meta) return <div className={styles.historyEntry}>{message.body}</div>;

  const text = callHistoryText(meta, myUserId);
  const missed = isMissedByMe(meta, myUserId);
  const busy = calls.call !== null && calls.call.phase !== 'ended';
  const canCallBack = peer !== null && !busy && hasMediaSupport();

  return (
    <div className={cx(styles.historyEntry, missed && styles.historyMissed)}>
      <span aria-hidden="true">{meta.media === 'video' ? '📹' : '📞'}</span>
      <span>{text}</span>
      <time className={styles.historyTime}>{time}</time>
      {peer && (
        <button
          type="button"
          className={styles.historyAction}
          disabled={!canCallBack}
          onClick={() => setCalling(true)}
          aria-label={`Call ${peer.displayName} back (${meta.media === 'video' ? 'video' : 'audio'})`}
        >
          Call back
        </button>
      )}
      {calling && peer && (
        <PreJoinDialog
          open
          onOpenChange={(open) => {
            if (!open) setCalling(false);
          }}
          media={meta.media}
          peer={peer}
          conversationId={message.conversationId}
        />
      )}
    </div>
  );
}
