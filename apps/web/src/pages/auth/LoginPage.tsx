import { isEmailIdentifier, loginSchema, type LoginInput } from '@videochat/shared';
import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { Button, Input } from '../../components/ui';
import { useAuth } from '../../features/auth/AuthContext';
import { resendVerification } from '../../features/auth/authApi';
import { ApiError } from '../../lib/api';
import { fieldErrors } from '../../lib/formErrors';
import { AuthLayout } from './AuthLayout';
import styles from './auth.module.css';

const EMPTY: LoginInput = { identifier: '', password: '' };

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/';

  const [form, setForm] = useState<LoginInput>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [unverified, setUnverified] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [resent, setResent] = useState(false);

  function update<K extends keyof LoginInput>(key: K) {
    return (e: React.ChangeEvent<HTMLInputElement>) => {
      setForm((prev) => ({ ...prev, [key]: e.target.value }));
    };
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    setUnverified(false);
    const result = loginSchema.safeParse(form);
    if (!result.success) {
      setErrors(fieldErrors(result.error));
      return;
    }
    setErrors({});
    setSubmitting(true);
    try {
      await login(result.data);
      void navigate(from, { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) {
        setUnverified(true);
      } else if (err instanceof ApiError) {
        setFormError(err.message);
      } else {
        setFormError('Something went wrong. Try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout>
      <h1>Log in</h1>
      {formError && (
        <p className={styles.formError} role="alert">
          {formError}
        </p>
      )}
      {unverified && (
        <p className={styles.formError} role="alert">
          Verify your email before logging in.{' '}
          {/* The resend endpoint takes an email address, and after a username login this form
              doesn't have one. (A "resend for the account I just proved I own" endpoint would
              remove this branch; not needed yet.) */}
          {isEmailIdentifier(form.identifier) ? (
            <Button
              variant="ghost"
              size="sm"
              loading={resent}
              onClick={async () => {
                setResent(true);
                try {
                  await resendVerification(form.identifier.trim());
                } finally {
                  setResent(false);
                }
              }}
            >
              Resend the email
            </Button>
          ) : (
            'To get a new link, log in with your email address instead.'
          )}
        </p>
      )}
      <form className={styles.form} onSubmit={handleSubmit} noValidate>
        <Input
          label="Email or username"
          type="text"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={form.identifier}
          onChange={update('identifier')}
          error={errors.identifier}
        />
        <Input
          label="Password"
          type="password"
          autoComplete="current-password"
          value={form.password}
          onChange={update('password')}
          error={errors.password}
        />
        <Button type="submit" loading={submitting}>
          Log in
        </Button>
      </form>
      <div className={styles.footerRow}>
        <Link to="/signup">Create an account</Link>
        <Link to="/forgot-password">Forgot password?</Link>
      </div>
    </AuthLayout>
  );
}
