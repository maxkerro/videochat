import { resetPasswordSchema } from '@videochat/shared';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Button, Input } from '../../components/ui';
import { resetPassword } from '../../features/auth/authApi';
import { ApiError } from '../../lib/api';
import { fieldErrors } from '../../lib/formErrors';
import { AuthLayout } from './AuthLayout';
import styles from './auth.module.css';

/** Landing page for the link emailed by forgot-password: /reset-password?token=... */
export function ResetPasswordPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token');

  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!token) {
      setFormError('This reset link is missing its token.');
      return;
    }
    const result = resetPasswordSchema.safeParse({ token, password });
    if (!result.success) {
      setError(fieldErrors(result.error).password);
      return;
    }
    setError(undefined);
    setSubmitting(true);
    try {
      await resetPassword(result.data);
      setDone(true);
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <AuthLayout>
        <h1>Password updated</h1>
        <p className={styles.notice}>You can log in with your new password now.</p>
        <Button onClick={() => void navigate('/login')}>Go to log in</Button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <h1>Choose a new password</h1>
      {formError && (
        <p className={styles.formError} role="alert">
          {formError}
        </p>
      )}
      <form className={styles.form} onSubmit={handleSubmit} noValidate>
        <Input
          label="New password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={error}
        />
        <Button type="submit" loading={submitting}>
          Update password
        </Button>
      </form>
      <p className={styles.centeredText}>
        <Link to="/login">Back to log in</Link>
      </p>
    </AuthLayout>
  );
}
