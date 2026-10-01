import type { CallMedia } from '@videochat/shared';
import { useState } from 'react';
import { Avatar, Button, Modal } from '../../components/ui';
import type { CallSnapshot } from './CallEngine';
import { useCalls } from './CallProvider';
import { acquireMedia, describeMediaError } from './mediaDevices';
import styles from './Calls.module.css';

/** CHAT-042 AC: "Incoming call modal with accept/decline." A video call can also be answered
 *  audio-only. A media error keeps it ringing, with the fix, rather than declining for the person. */
export function IncomingCallDialog({ call }: { call: CallSnapshot }) {
  const calls = useCalls();
  const [error, setError] = useState<{ title: string; fix: string } | null>(null);
  const [answering, setAnswering] = useState(false);
  const kind = call.media === 'video' ? 'video' : 'audio';

  const answer = async (media: CallMedia) => {
    setAnswering(true);
    setError(null);
    try {
      const stream = await acquireMedia(media);
      await calls.accept(stream);
    } catch (err) {
      setError(describeMediaError(err, media));
      setAnswering(false);
    }
  };

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) calls.decline();
      }}
      title={`Incoming ${kind} call`}
      description={`${call.peer.displayName} is calling you`}
      footer={
        <>
          <Button variant="danger" onClick={() => calls.decline()} disabled={answering}>
            Decline
          </Button>
          {call.media === 'video' && (
            <Button variant="secondary" onClick={() => void answer('audio')} loading={answering}>
              Answer audio only
            </Button>
          )}
          <Button onClick={() => void answer(call.media)} loading={answering}>
            Answer
          </Button>
        </>
      }
    >
      <div className={styles.incoming}>
        <span className={styles.ringing}>
          <Avatar name={call.peer.displayName} src={call.peer.avatarUrl} size="lg" />
        </span>
      </div>
      {error && (
        <div className={styles.error} role="alert">
          <p className={styles.errorTitle}>{error.title}</p>
          <p>{error.fix}</p>
        </div>
      )}
    </Modal>
  );
}
