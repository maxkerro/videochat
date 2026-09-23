import { Link } from 'react-router';
import styles from './pages.module.css';

export function NotFoundPage() {
  return (
    <section className={styles.empty}>
      <h1>Page not found</h1>
      <p>The link may be broken or the page may have moved.</p>
      <Link to="/">Go to conversations</Link>
    </section>
  );
}
