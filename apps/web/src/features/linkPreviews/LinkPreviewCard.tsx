import type { LinkPreview } from '@videochat/shared';
import styles from './LinkPreviewCard.module.css';

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/** CHAT-031: a link's title, description and image. `onRemove` adds a dismiss button. */
export function LinkPreviewCard({
  preview,
  onRemove,
  removeLabel = 'Remove link preview',
}: {
  preview: LinkPreview;
  onRemove?: () => void;
  removeLabel?: string;
}) {
  return (
    <div className={styles.card}>
      {preview.imageUrl && (
        <img
          className={styles.image}
          src={preview.imageUrl}
          alt=""
          loading="lazy"
          // The image is on a third-party host: don't tell it which conversation it's in.
          referrerPolicy="no-referrer"
        />
      )}
      <div className={styles.text}>
        <span className={styles.site}>{preview.siteName ?? hostOf(preview.url)}</span>
        <a className={styles.title} href={preview.url} target="_blank" rel="noopener noreferrer">
          {preview.title}
        </a>
        {preview.description && <span className={styles.description}>{preview.description}</span>}
      </div>
      {onRemove && (
        <button type="button" className={styles.remove} onClick={onRemove} aria-label={removeLabel}>
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M4 4l8 8M12 4l-8 8"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
        </button>
      )}
    </div>
  );
}
