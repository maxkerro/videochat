import type { ReactNode } from 'react';
import { Link } from 'react-router';
import styles from './auth.module.css';

/** Shared centered-card chrome for every auth screen (sign up, log in, verify, reset). */
export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <Link to="/" className={styles.brand}>
          <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true">
            <rect width="32" height="32" rx="8" fill="var(--color-accent)" />
            <path
              d="M9 11.5A3.5 3.5 0 0 1 12.5 8h7A3.5 3.5 0 0 1 23 11.5v5a3.5 3.5 0 0 1-3.5 3.5H15l-4.2 3.4c-.6.5-1.8.1-1.8-.8Z"
              fill="var(--color-accent-text)"
            />
          </svg>
          Videochat
        </Link>
        <div className={styles.panel}>{children}</div>
      </div>
    </div>
  );
}
