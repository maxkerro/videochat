import { useState } from 'react';
import { useRouter } from 'expo-router';
import { requestPasswordResetSchema } from '@videochat/shared';
import { z } from 'zod';
import { publicApi } from '../../src/lib/api';
import { Button, Field, FormScreen, Notice } from '../../src/ui/Form';
import { describeError } from '../../src/ui/describeError';
import { fieldErrors } from '../../src/ui/useFormErrors';

export default function ForgotPassword() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [formError, setFormError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setFormError(null);
    const parsed = requestPasswordResetSchema.safeParse({ email });
    if (!parsed.success) return setError(fieldErrors(parsed.error).email);
    setError(undefined);
    setBusy(true);
    try {
      await publicApi.apiPost('/auth/request-password-reset', z.unknown(), parsed.data);
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
          If that email has an account, we sent a reset link. Open the link to choose a new
          password, then log in here.
        </Notice>
        <Button title="Back to log in" onPress={() => router.replace('/login')} />
      </FormScreen>
    );
  }

  return (
    <FormScreen title="Reset your password">
      <Field
        label="Email"
        value={email}
        onChangeText={setEmail}
        error={error}
        autoCapitalize="none"
        autoComplete="email"
        autoCorrect={false}
        keyboardType="email-address"
      />
      {formError ? <Notice kind="error">{formError}</Notice> : null}
      <Button title="Send reset link" busy={busy} onPress={() => void submit()} />
      <Button title="Back" kind="link" onPress={() => router.back()} />
    </FormScreen>
  );
}
