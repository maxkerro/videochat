import { signUpSchema, type SignUpInput } from '@videochat/shared';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Button, Input } from '../../components/ui';
import { resendVerification, signUp } from '../../features/auth/authApi';
import { ApiError } from '../../lib/api';
import { fieldErrors } from '../../lib/formErrors';
import { AuthLayout } from './AuthLayout';
import styles from './auth.module.css';

const EMPTY: SignUpInput = { email: '', username: '', displayName: '', password: '' };

export function SignUpPage() {
  const [form, setForm] = useState<SignUpInput>(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [resent, setResent] = useState(false);

  function update<K extends keyof SignUpInput>(key: K) {
    return (e: React.ChangeEvent<HTMLInputElement>) => {
      setForm((prev) => ({ ...prev, [key]: e.target.value }));
    };
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setFormError(null);
    const result = signUpSchema.safeParse(form);
    if (!result.success) {
      setErrors(fieldErrors(result.error));
      return;
    }
    setErrors({});
    setSubmitting(true);
    try {
      await signUp(result.data);
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
        <h1>Check your email</h1>
        <p className={styles.notice}>
          We sent a verification link to <strong>{form.email}</strong>. Click it to activate your
          account, then log in.
        </p>
        <Button
          variant="secondary"
          loading={resent}
          onClick={async () => {
            setResent(true);
            try {
              await resendVerification(form.email);
            } finally {
              setResent(false);
            }
          }}
        >
          Resend email
        </Button>
        <p className={styles.centeredText}>
          <Link to="/login">Back to log in</Link>
        </p>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <h1>Create your account</h1>
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
          value={form.email}
          onChange={update('email')}
          error={errors.email}
        />
        <Input
          label="Username"
          autoComplete="username"
          value={form.username}
          onChange={update('username')}
          error={errors.username}
          hint="Lowercase letters, digits and underscores only."
        />
        <Input
          label="Display name"
          autoComplete="name"
          value={form.displayName}
          onChange={update('displayName')}
          error={errors.displayName}
        />
        <Input
          label="Password"
          type="password"
          autoComplete="new-password"
          value={form.password}
          onChange={update('password')}
          error={errors.password}
        />
        <Button type="submit" loading={submitting}>
          Sign up
        </Button>
      </form>
      <p className={styles.centeredText}>
        Already have an account? <Link to="/login">Log in</Link>
      </p>
    </AuthLayout>
  );
}
