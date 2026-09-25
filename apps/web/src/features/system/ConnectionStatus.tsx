import { useAuth } from '../auth/AuthContext';
import { useRealtimeStatus } from '../chat/RealtimeProvider';
import { cx } from '../../lib/cx';
import styles from './ConnectionStatus.module.css';

/**
 * CHAT-017: small connection indicator in the sidebar footer, replacing CHAT-013-era `ApiStatus`'s
 * separate `/health` poll -- the realtime socket's own status is a more honest signal of "can this
 * app actually talk to the server right now" than a periodic ping, and it updates the instant the
 * connection drops or recovers rather than up to 30s later. Doubles as the "Connecting…" banner
 * called for by CHAT-017's AC: shown whenever the socket isn't `open`, whether that's the very
 * first connect, a drop, or a reconnect attempt in progress.
 */
export function ConnectionStatus() {
  const auth = useAuth();
  const status = useRealtimeStatus();
  // Signed out, the socket is always `closed` (there's no session to connect with) -- that's not
  // "reconnecting", it's simply not applicable, so nothing renders rather than showing a
  // perpetually-stuck indicator on the login/landing views this same shell renders.
  if (auth.status !== 'authenticated') return null;
  const state = status === 'open' ? 'online' : status === 'connecting' ? 'checking' : 'offline';
  const label = {
    checking: 'Connecting…',
    online: 'Connected',
    offline: 'Reconnecting…',
  }[state];

  return (
    <p className={styles.status} role="status">
      <span className={cx(styles.dot, styles[state])} aria-hidden="true" />
      {label}
    </p>
  );
}
