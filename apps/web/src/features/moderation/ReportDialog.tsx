import { REPORT_REASONS, type Message, type ReportReason } from '@videochat/shared';
import { useState } from 'react';
import { Button, Modal, useToast } from '../../components/ui';
import { useAuth, withAuthRetry } from '../auth/AuthContext';
import { useE2ee } from '../e2ee';
import { reportMessage, reportUser } from './moderationApi';
import styles from './Moderation.module.css';

export const REASON_LABELS: Record<ReportReason, string> = {
  spam: 'Spam or scam',
  harassment: 'Harassment or bullying',
  inappropriate: 'Inappropriate content',
  other: 'Something else',
};

export type ReportTarget =
  | { kind: 'message'; message: Message; senderName: string }
  | { kind: 'user'; userId: string; name: string; conversationId: string };

/**
 * CHAT-077: "Report" for a message or a person. Moderators see the reported message and a few
 * messages around it -- the dialog says so, so nobody is surprised.
 */
export function ReportDialog({
  target,
  onClose,
}: {
  target: ReportTarget | null;
  onClose: () => void;
}) {
  const auth = useAuth();
  const { toast } = useToast();
  const e2ee = useE2ee();
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [details, setDetails] = useState('');
  const [sending, setSending] = useState(false);
  const encrypted = target?.kind === 'message' && !!target.message.e2ee;

  function close() {
    setReason(null);
    setDetails('');
    onClose();
  }

  async function submit() {
    if (!target || !reason) return;
    setSending(true);
    try {
      const base = { reason, ...(details.trim() ? { details: details.trim() } : {}) };
      if (target.kind === 'message') {
        // The server can't read an encrypted message: send what this browser decrypted.
        let decryptedText: string | undefined;
        if (encrypted && e2ee) {
          const result = await e2ee.decrypt(target.message);
          if (result.status === 'ok') decryptedText = result.text;
        }
        await withAuthRetry(auth, (token) =>
          reportMessage(token, target.message.conversationId, target.message.id, {
            ...base,
            ...(decryptedText ? { decryptedText } : {}),
          }),
        );
      } else {
        await withAuthRetry(auth, (token) =>
          reportUser(token, target.userId, { ...base, conversationId: target.conversationId }),
        );
      }
      toast({ title: 'Thanks. Our moderators will review it.' });
      close();
    } catch {
      toast({ title: 'Couldn’t send the report. Try again.', tone: 'danger' });
    } finally {
      setSending(false);
    }
  }

  const title =
    target?.kind === 'user'
      ? `Report ${target.name}`
      : `Report a message from ${target?.senderName ?? ''}`;
  return (
    <Modal
      open={!!target}
      onOpenChange={(open) => !open && close()}
      title={title}
      description={
        target?.kind === 'user'
          ? 'Moderators will see your report and this person’s account.'
          : encrypted
            ? 'This message is end-to-end encrypted: the text you see is sent with your report, and moderators see a few messages around it.'
            : 'Moderators will see this message and a few messages around it.'
      }
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={!reason}
            loading={sending}
            onClick={() => void submit()}
          >
            Report
          </Button>
        </>
      }
    >
      <fieldset className={styles.reasons}>
        <legend>Why are you reporting this?</legend>
        {REPORT_REASONS.map((r) => (
          <label key={r} className={styles.radio}>
            <input
              type="radio"
              name="report-reason"
              value={r}
              checked={reason === r}
              onChange={() => setReason(r)}
            />
            {REASON_LABELS[r]}
          </label>
        ))}
      </fieldset>
      <label className={styles.field}>
        <span>Anything else? (optional)</span>
        <textarea
          value={details}
          maxLength={500}
          rows={3}
          onChange={(e) => setDetails(e.target.value)}
        />
      </label>
    </Modal>
  );
}
