import { requestPasswordResetSchema } from '@videochat/shared';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Button, Input } from '../../components/ui';
import { requestPasswordReset } from '../../features/auth/authApi';
import { ApiError } from '../../lib/api';
import { fieldErrors } from '../../lib/formErrors';
import { AuthLayout } from './AuthLayout';
import styles from './auth.module.css';

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const result = requestPasswordResetSchema.safeParse({ email });
    if (!result.success) {
      setError(fieldErrors(result.error).email);
      return;
    }
    setError(undefined);
    setSubmitting(true);
    try {
      await requestPasswordReset(result.data);
      setSent(true);
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  if (sent) {
    return (
      <AuthLayout>
        <h1>Check your email</h1>
        <p className={styles.notice}>
          If <strong>{email}</strong> has an account, we sent a link to reset the password.
        </p>
        <p className={styles.centeredText}>
          <Link to="/login">Back to log in</Link>
        </p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <h1>Reset your password</h1>
      <p className={styles.subtitle}>We'll email you a link to set a new one.</p>
      {formError && (
        <p className={styles.formError} role="alert">
          {formError}
        </p>
      )}
      <form className={styles.form} onSubmit={handleSubmit} noValidate>
        <Input
          label="Email"
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={error}
        />
        <Button type="submit" loading={submitting}>
          Send reset link
        </Button>
      </form>
      <p className={styles.centeredText}>
        <Link to="/login">Back to log in</Link>
      </p>
    </AuthLayout>
  );
}
