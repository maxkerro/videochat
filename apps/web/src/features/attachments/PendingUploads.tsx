import { Button } from '../../components/ui';
import { formatBytes } from './attachmentsApi';
import type { PendingUpload } from './useAttachmentUploads';
import styles from './Attachments.module.css';

/** CHAT-030: files on their way, above the composer: progress, cancel, retry. */
export function PendingUploads({
  uploads,
  onCancel,
  onRetry,
}: {
  uploads: PendingUpload[];
  onCancel: (localId: string) => void;
  onRetry: (localId: string) => void;
}) {
  if (!uploads.length) return null;
  return (
    <ul className={styles.uploads} aria-label="Uploads">
      {uploads.map((u) => {
        const pct = Math.round(u.progress * 100);
        return (
          <li key={u.localId} className={styles.upload}>
            <div className={styles.uploadMain}>
              <span className={styles.uploadName}>
                {u.file.name || 'file'} · {formatBytes(u.file.size)}
              </span>
              {u.status === 'failed' ? (
                <span className={styles.uploadError} role="alert">
                  {u.error}
                </span>
              ) : (
                <div
                  className={styles.progress}
                  role="progressbar"
                  aria-label={`Uploading ${u.file.name || 'file'}`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={pct}
                >
                  <span style={{ width: `${u.status === 'sending' ? 100 : pct}%` }} />
                </div>
              )}
            </div>
            {u.status === 'failed' && (
              <Button variant="ghost" size="sm" onClick={() => onRetry(u.localId)}>
                Retry
              </Button>
            )}
            {u.status !== 'sending' && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onCancel(u.localId)}
                aria-label={`Cancel ${u.file.name || 'upload'}`}
              >
                Cancel
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
