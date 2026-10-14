import { Button } from '../../components/ui';
import { useOptionalCallsBusy } from './busy';
import { useGroupCall } from './GroupCallProvider';
import { participantsText, useRunningGroupCall } from './useRunningGroupCall';
import styles from './GroupCalls.module.css';

/**
 * CHAT-070: in a group chat's header, "Group call" starts one; while one is running, a banner
 * under the header lets anyone (including late joiners) join it.
 */
export function GroupCallButton({
  conversationId,
  title,
}: {
  conversationId: string;
  title: string;
}) {
  const groupCall = useGroupCall();
  const running = useRunningGroupCall(conversationId, true);
  const busy = useOptionalCallsBusy();
  const here = groupCall.session?.conversationId === conversationId;
  if (running || here) return null;
  return (
    <Button
      variant="ghost"
      size="sm"
      disabled={busy || groupCall.joining !== null}
      onClick={() => void groupCall.join(conversationId, title)}
      title={busy ? 'Finish your current call first' : undefined}
    >
      Group call
    </Button>
  );
}

export function GroupCallBanner({
  conversationId,
  title,
}: {
  conversationId: string;
  title: string;
}) {
  const groupCall = useGroupCall();
  const running = useRunningGroupCall(conversationId, true);
  const busy = useOptionalCallsBusy();
  if (!running) return null;
  const here = groupCall.session?.conversationId === conversationId;
  return (
    <div className={styles.banner} role="status">
      <span className={styles.dot} aria-hidden="true" />
      <span className={styles.bannerText}>
        <strong>Group call</strong> · {participantsText(running)}
      </span>
      {here ? (
        <span className={styles.bannerNote}>You’re in this call</span>
      ) : (
        <Button
          size="sm"
          disabled={busy || groupCall.joining !== null}
          onClick={() => void groupCall.join(conversationId, title)}
        >
          {groupCall.joining === conversationId ? 'Joining…' : 'Join'}
        </Button>
      )}
    </div>
  );
}
