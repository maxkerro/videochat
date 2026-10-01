import { Link } from 'react-router';
import { Avatar, Button } from '../../components/ui';
import type { CallSnapshot } from './CallEngine';
import { useCalls } from './CallProvider';
import { callStatusText } from './CallView';
import { useCallTimer } from './useCallTimer';
import styles from './Calls.module.css';

/** CHAT-042 AC: "The call continues if the user navigates to another chat (minimised call bar)." */
export function CallBar({ call }: { call: CallSnapshot }) {
  const calls = useCalls();
  const timer = useCallTimer(call.startedAt);
  return (
    <section className={styles.bar} aria-label={`Call with ${call.peer.displayName}`}>
      <Avatar name={call.peer.displayName} src={call.peer.avatarUrl} size="sm" />
      <span className={styles.barText}>
        <span className={styles.barName}>{call.peer.displayName}</span>
        <span className={styles.barStatus} role="status">
          {callStatusText(call, timer)}
        </span>
      </span>
      <Button
        variant="ghost"
        size="sm"
        aria-pressed={!call.audioEnabled}
        onClick={() => calls.toggleAudio()}
      >
        {call.audioEnabled ? 'Mute' : 'Unmute'}
      </Button>
      <Link
        to={`/c/${call.conversationId}`}
        onClick={() => calls.setExpanded(true)}
        aria-label="Return to call"
      >
        <Button variant="secondary" size="sm" tabIndex={-1}>
          Return
        </Button>
      </Link>
      <Button variant="danger" size="sm" onClick={() => calls.hangUp()}>
        {call.phase === 'outgoing' ? 'Cancel' : 'Hang up'}
      </Button>
    </section>
  );
}
