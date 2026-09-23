import { useState } from 'react';
import { cx } from '../../lib/cx';
import styles from './Avatar.module.css';

export interface AvatarProps {
  name: string;
  src?: string | null;
  size?: 'sm' | 'md' | 'lg';
  /** Shows a presence dot (wired to real presence in CHAT-034). */
  online?: boolean;
  className?: string;
}

/** Up to two initials from a display name: "Anna Schmidt" → "AS". */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = parts[0]?.[0] ?? '?';
  const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

/** Deterministic hue per name so each person keeps the same color everywhere. */
function hueFor(name: string): number {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

export function Avatar({ name, src, size = 'md', online, className }: AvatarProps) {
  const [failed, setFailed] = useState(false);
  const showImage = src && !failed;
  return (
    <span
      className={cx(styles.avatar, styles[size], className)}
      style={{ ['--avatar-hue' as string]: hueFor(name) }}
      role="img"
      aria-label={online ? `${name}, online` : name}
    >
      {showImage ? (
        <img src={src} alt="" className={styles.img} onError={() => setFailed(true)} />
      ) : (
        <span aria-hidden="true">{initials(name)}</span>
      )}
      {online && <span className={styles.dot} aria-hidden="true" />}
    </span>
  );
}
