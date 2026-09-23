import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Button } from '../../components/ui';
import { verifyEmail } from '../../features/auth/authApi';
import { ApiError } from '../../lib/api';
import { AuthLayout } from './AuthLayout';
import styles from './auth.module.css';

/** Landing page for the link emailed on sign-up: /verify-email?token=... */
export function VerifyEmailPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token');
  const [state, setState] = useState<'pending' | 'success' | 'error'>(token ? 'pending' : 'error');
  const [error, setError] = useState<string | null>(
    token ? null : 'This verification link is missing its token.',
  );
  const requested = useRef(false);

  useEffect(() => {
    if (!token || requested.current) return;
    requested.current = true;
    verifyEmail({ token })
      .then(() => setState('success'))
      .catch((err: unknown) => {
        setState('error');
        setError(err instanceof ApiError ? err.message : 'Something went wrong.');
      });
  }, [token]);

  return (
    <AuthLayout>
      <h1>Verify your email</h1>
      {state === 'pending' && <p className={styles.subtitle}>Verifying…</p>}
      {state === 'success' && (
        <>
          <p className={styles.notice}>Your email is verified. You can log in now.</p>
          <Button onClick={() => void navigate('/login')}>Go to log in</Button>
        </>
      )}
      {state === 'error' && (
        <>
          <p className={styles.formError} role="alert">
            {error}
          </p>
          <p className={styles.centeredText}>
            <Link to="/login">Back to log in</Link>
          </p>
        </>
      )}
    </AuthLayout>
  );
}
