import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Button } from '../../components/ui';
import { useAuth } from '../../features/auth/AuthContext';
import { ApiError } from '../../lib/api';
import { AuthLayout } from './AuthLayout';
import styles from './auth.module.css';

/**
 * CHAT-081: the emailed sign-in link lands here. It signs in only on a click, so a mail scanner
 * that opens links ahead of the person can't use it up.
 */
export function LoginLinkPage() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const { loginWithLink } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function signIn() {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      await loginWithLink({ token });
      void navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout>
      <h1>Sign in to Videochat</h1>
      {!token ? (
        <p className={styles.formError} role="alert">
          This link is incomplete. Ask for a new one on the log-in page.
        </p>
      ) : (
        <>
          <p className={styles.subtitle}>You asked for a sign-in link. Continue to sign in.</p>
          {error && (
            <p className={styles.formError} role="alert">
              {error}
            </p>
          )}
          <Button loading={busy} onClick={() => void signIn()}>
            Sign in
          </Button>
        </>
      )}
      <div className={styles.footerRow}>
        <Link to="/login">Back to log in</Link>
      </div>
    </AuthLayout>
  );
}
