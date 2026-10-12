import { useState } from 'react';
import { useRouter } from 'expo-router';
import { signUpSchema } from '@videochat/shared';
import { z } from 'zod';
import { publicApi } from '../../src/lib/api';
import { Button, Field, FormScreen, Notice } from '../../src/ui/Form';
import { describeError } from '../../src/ui/describeError';
import { fieldErrors } from '../../src/ui/useFormErrors';

export default function SignUp() {
  const router = useRouter();
  const [form, setForm] = useState({ email: '', username: '', displayName: '', password: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  const set = (key: keyof typeof form) => (value: string) =>
    setForm((f) => ({ ...f, [key]: value }));

  async function submit() {
    setFormError(null);
    const parsed = signUpSchema.safeParse({
      ...form,
      username: form.username.trim().toLowerCase(),
    });
    if (!parsed.success) return setErrors(fieldErrors(parsed.error));
    setErrors({});
    setBusy(true);
    try {
      await publicApi.apiPost('/auth/signup', z.unknown(), parsed.data);
      setSent(true);
    } catch (e) {
      setFormError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <FormScreen title="Check your email">
        <Notice kind="ok">
          We sent a verification link to {form.email}. Open it, then come back and log in.
        </Notice>
        <Button title="Back to log in" onPress={() => router.replace('/login')} />
      </FormScreen>
    );
  }

  return (
    <FormScreen title="Create an account">
      <Field
        label="Email"
        value={form.email}
        onChangeText={set('email')}
        error={errors.email}
        autoCapitalize="none"
        autoComplete="email"
        autoCorrect={false}
        keyboardType="email-address"
        textContentType="emailAddress"
      />
      <Field
        label="Username"
        value={form.username}
        onChangeText={set('username')}
        error={errors.username}
        autoCapitalize="none"
        autoComplete="username-new"
        autoCorrect={false}
      />
      <Field
        label="Display name"
        value={form.displayName}
        onChangeText={set('displayName')}
        error={errors.displayName}
        autoComplete="name"
      />
      <Field
        label="Password"
        value={form.password}
        onChangeText={set('password')}
        error={errors.password}
        secureTextEntry
        autoComplete="new-password"
        textContentType="newPassword"
      />
      {formError ? <Notice kind="error">{formError}</Notice> : null}
      <Button title="Sign up" busy={busy} onPress={() => void submit()} />
      <Button title="I already have an account" kind="link" onPress={() => router.back()} />
    </FormScreen>
  );
}
