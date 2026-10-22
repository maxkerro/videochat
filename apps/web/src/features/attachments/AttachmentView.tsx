import { useQueryClient } from '@tanstack/react-query';
import type { Attachment } from '@videochat/shared';
import { useState } from 'react';
import { Button, Modal, useToast } from '../../components/ui';
import { useAuth, withAuthRetry } from '../auth/AuthContext';
import { fetchAttachmentUrl, formatBytes } from './attachmentsApi';
import { useSignedImage } from './useSignedImage';
import styles from './Attachments.module.css';
import { VoiceMessage } from '../voice/VoiceMessage';

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
  // CHAT-074: a voice message plays in place.
  if (attachment.voice)
    return <VoiceMessage attachment={{ ...attachment, voice: attachment.voice }} />;
  return attachment.kind === 'image' ? (
    <ImageAttachment attachment={attachment} />
  ) : (
    <FileAttachment attachment={attachment} />
  );
}

function ImageAttachment({ attachment }: { attachment: Attachment }) {
  const [open, setOpen] = useState(false);
  const thumb = useSignedImage(attachment.id, 'thumb');
  const original = useSignedImage(attachment.id, 'original', open);
  const box = thumbBox(attachment.width, attachment.height);
  return (
    <>
      {thumb.state === 'error' ? (
        <div
          className={styles.imageError}
          style={{ width: box.width, height: box.height }}
          role="alert"
        >
          <span>Couldn’t load this photo.</span>
          <Button variant="secondary" size="sm" onClick={thumb.retry}>
            Retry
          </Button>
        </div>
      ) : (
        <button
          type="button"
          className={styles.imageButton}
          style={{ width: box.width, height: box.height }}
          onClick={() => setOpen(true)}
          aria-label={`Open image ${attachment.filename}`}
        >
          {thumb.src ? (
            <img
              src={thumb.src}
              alt={attachment.filename}
              width={box.width}
              height={box.height}
              className={styles.image}
              onLoad={thumb.onLoad}
              onError={thumb.onError}
            />
          ) : (
            <span className={styles.imagePlaceholder} aria-hidden="true" />
          )}
        </button>
      )}
      <Modal open={open} onOpenChange={setOpen} title={attachment.filename} footer={null}>
        <div className={styles.lightbox}>
          {original.state === 'error' ? (
            <div role="alert" className={styles.lightboxError}>
              <p>Couldn’t load this image.</p>
              <Button variant="secondary" size="sm" onClick={original.retry}>
                Retry
              </Button>
            </div>
          ) : original.src ? (
            <img
              src={original.src}
              alt={attachment.filename}
              className={styles.lightboxImage}
              onLoad={original.onLoad}
              onError={original.onError}
            />
          ) : (
            <p role="status">Loading…</p>
          )}
          {original.src && original.state !== 'error' && (
            <a href={original.src} target="_blank" rel="noopener noreferrer">
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
