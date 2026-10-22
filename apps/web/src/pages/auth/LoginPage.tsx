import { isEmailIdentifier, loginSchema, type LoginInput } from '@videochat/shared';
import { useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { Button, Input } from '../../components/ui';
import { useAuth } from '../../features/auth/AuthContext';
import { requestLoginLink, resendVerification } from '../../features/auth/authApi';
import { ApiError } from '../../lib/api';
import { fieldErrors } from '../../lib/formErrors';
import { AuthLayout } from './AuthLayout';
import styles from './auth.module.css';

const EMPTY: LoginInput = { identifier: '', password: '' };

export function LoginPage() {
  const { login, loginWithLink } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/';

  const [form, setForm] = useState<LoginInput>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [unverified, setUnverified] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [resent, setResent] = useState(false);
  // CHAT-081: signing in with an emailed code instead of the password.
  const [codeFor, setCodeFor] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [sendingCode, setSendingCode] = useState(false);

  async function emailCode() {
    setFormError(null);
    const identifier = form.identifier.trim();
    if (!identifier) {
      setErrors({ identifier: 'Enter your email or username first' });
      return;
    }
    setErrors({});
    setSendingCode(true);
    try {
      await requestLoginLink(identifier);
      setCodeFor(identifier);
      setCode('');
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
    } finally {
      setSendingCode(false);
    }
  }

  async function submitCode(e: FormEvent) {
    e.preventDefault();
    if (!codeFor) return;
    setFormError(null);
    if (!/^\d{6}$/.test(code.trim())) {
      setErrors({ code: 'Enter the 6-digit code from the email' });
      return;
    }
    setErrors({});
    setSubmitting(true);
    try {
      await loginWithLink({ identifier: codeFor, code: code.trim() });
      void navigate(from, { replace: true });
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Something went wrong. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

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
      // Only "verify your email" offers a new link; other 403s (a lockout, CHAT-077's suspension
      // or ban) say what the server said.
      if (
        err instanceof ApiError &&
        err.status === 403 &&
        (err.code === 'email_unverified' || /verif/i.test(err.message))
      ) {
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

  if (codeFor) {
    return (
      <AuthLayout>
        <h1>Check your email</h1>
        <p className={styles.subtitle}>
          If an account matches <strong>{codeFor}</strong>, we emailed it a sign-in link and a
          6-digit code. Open the link, or enter the code here. Both work once, for 15 minutes.
        </p>
        {formError && (
          <p className={styles.formError} role="alert">
            {formError}
          </p>
        )}
        <form className={styles.form} onSubmit={submitCode} noValidate>
          <Input
            label="Code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            error={errors.code}
          />
          <Button type="submit" loading={submitting}>
            Sign in
          </Button>
        </form>
        <div className={styles.footerRow}>
          <Button variant="ghost" size="sm" loading={sendingCode} onClick={() => void emailCode()}>
            Send another email
          </Button>
          <Button variant="ghost" size="sm" onClick={() => setCodeFor(null)}>
            Use my password
          </Button>
        </div>
      </AuthLayout>
    );
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
      {/* CHAT-081: works even while password sign-in is delayed after failed attempts. */}
      <Button variant="ghost" loading={sendingCode} onClick={() => void emailCode()}>
        Email me a sign-in code instead
      </Button>
      <div className={styles.footerRow}>
        <Link to="/signup">Create an account</Link>
        <Link to="/forgot-password">Forgot password?</Link>
      </div>
    </AuthLayout>
  );
}
