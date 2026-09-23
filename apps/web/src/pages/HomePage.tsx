import styles from './pages.module.css';

/** Shown in the chat pane when no conversation is selected (desktop only). */
export function HomePage() {
  return (
    <section className={styles.empty}>
      <svg width="56" height="56" viewBox="0 0 32 32" aria-hidden="true">
        <path
          d="M6 10.5A4.5 4.5 0 0 1 10.5 6h11A4.5 4.5 0 0 1 26 10.5v7a4.5 4.5 0 0 1-4.5 4.5H15l-5.6 4.4c-.9.7-2.4.1-2.4-1.1V22.2A4.5 4.5 0 0 1 6 17.5Z"
          fill="var(--color-accent-soft)"
          stroke="var(--color-accent)"
          strokeWidth="1.5"
        />
      </svg>
      <h1>Select a conversation</h1>
      <p>Pick a chat from the list, or start a new one with the + button.</p>
    </section>
  );
}
