import { useQueryClient } from '@tanstack/react-query';
import type { Attachment } from '@videochat/shared';
import { useState } from 'react';
import { Button, Modal, useToast } from '../../components/ui';
import { useAuth, withAuthRetry } from '../auth/AuthContext';
import { fetchAttachmentUrl, formatBytes } from './attachmentsApi';
import { useAttachmentUrl } from './useAttachmentUrl';
import styles from './Attachments.module.css';

/** Largest a thumbnail is drawn in the message list, in CSS px. */
const THUMB_MAX_W = 280;
const THUMB_MAX_H = 320;

export function thumbBox(width: number | null, height: number | null) {
  if (!width || !height) return { width: THUMB_MAX_W, height: Math.round(THUMB_MAX_W * 0.75) };
  const scale = Math.min(THUMB_MAX_W / width, THUMB_MAX_H / height, 1);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/** CHAT-030: an image (thumbnail, opens a lightbox) or a file card (name, size, download). */
export function AttachmentView({ attachment }: { attachment: Attachment }) {
  return attachment.kind === 'image' ? (
    <ImageAttachment attachment={attachment} />
  ) : (
    <FileAttachment attachment={attachment} />
  );
}

function ImageAttachment({ attachment }: { attachment: Attachment }) {
  const [open, setOpen] = useState(false);
  const thumb = useAttachmentUrl(attachment.id, 'thumb');
  const original = useAttachmentUrl(attachment.id, 'original', open);
  const box = thumbBox(attachment.width, attachment.height);
  return (
    <>
      <button
        type="button"
        className={styles.imageButton}
        style={{ width: box.width, height: box.height }}
        onClick={() => setOpen(true)}
        aria-label={`Open image ${attachment.filename}`}
      >
        {thumb.data ? (
          <img
            src={thumb.data}
            alt={attachment.filename}
            width={box.width}
            height={box.height}
            className={styles.image}
            // A signed URL that expired while the page sat open: get a fresh one.
            onError={() => void thumb.refetch()}
          />
        ) : (
          <span className={styles.imagePlaceholder} aria-hidden="true" />
        )}
      </button>
      <Modal open={open} onOpenChange={setOpen} title={attachment.filename} footer={null}>
        <div className={styles.lightbox}>
          {original.data ? (
            <img src={original.data} alt={attachment.filename} className={styles.lightboxImage} />
          ) : original.isError ? (
            <p role="alert">Couldn’t load this image.</p>
          ) : (
            <p role="status">Loading…</p>
          )}
          {original.data && (
            <a href={original.data} target="_blank" rel="noopener noreferrer">
              Open original ({formatBytes(attachment.sizeBytes)})
            </a>
          )}
        </div>
      </Modal>
    </>
  );
}

function FileAttachment({ attachment }: { attachment: Attachment }) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);

  async function download() {
    setBusy(true);
    try {
      // Always a fresh URL: it carries the download filename and expires in minutes anyway.
      const { url } = await withAuthRetry(auth, (token) =>
        fetchAttachmentUrl(token, attachment.id, 'original'),
      );
      queryClient.setQueryData(['attachment-url', attachment.id, 'original'], url);
      const a = document.createElement('a');
      a.href = url;
      a.rel = 'noopener noreferrer';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch {
      toast({ title: 'Couldn’t download that file', tone: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.file}>
      <span className={styles.fileIcon} aria-hidden="true">
        <svg width="20" height="20" viewBox="0 0 24 24">
          <path
            d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z M14 3v5h5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <span className={styles.fileText}>
        <span className={styles.fileName}>{attachment.filename}</span>
        <span className={styles.fileSize}>{formatBytes(attachment.sizeBytes)}</span>
      </span>
      <Button
        variant="ghost"
        size="sm"
        loading={busy}
        onClick={() => void download()}
        aria-label={`Download ${attachment.filename}`}
      >
        Download
      </Button>
    </div>
  );
}
