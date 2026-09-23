import { useQuery } from '@tanstack/react-query';
import { healthResponseSchema } from '@videochat/shared';
import { apiGet } from '../../lib/api';
import { cx } from '../../lib/cx';
import styles from './ApiStatus.module.css';

/**
 * Small connection indicator in the sidebar footer. Proves the web → API → shared-types path
 * end to end; the realtime connection banner replaces it in CHAT-017.
 */
export function ApiStatus() {
  const { data, isPending, isError } = useQuery({
    queryKey: ['health'],
    queryFn: () => apiGet('/health', healthResponseSchema),
    refetchInterval: 30_000,
    retry: 1,
  });

  const state = isPending
    ? 'checking'
    : isError
      ? 'offline'
      : data.status === 'ok'
        ? 'online'
        : 'degraded';
  const label = {
    checking: 'Checking connection…',
    online: 'Connected',
    degraded: 'Connected, some services are down',
    offline: 'Can’t reach the server',
  }[state];

  return (
    <p className={styles.status} role="status" title={data ? `API ${data.version}` : undefined}>
      <span className={cx(styles.dot, styles[state])} aria-hidden="true" />
      {label}
    </p>
  );
}
