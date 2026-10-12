import { useState } from 'react';
import { useRouter } from 'expo-router';
import { loginSchema } from '@videochat/shared';
import { config, session } from '../../src/lib/api';
import { Button, Field, FormScreen, Notice } from '../../src/ui/Form';
import { Text } from 'react-native';
import { useTheme } from '../../src/ui/theme';
import { describeError } from '../../src/ui/describeError';
import { fieldErrors } from '../../src/ui/useFormErrors';

export default function Login() {
  const theme = useTheme();
  const router = useRouter();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setFormError(null);
    const parsed = loginSchema.safeParse({ identifier, password });
    if (!parsed.success) return setErrors(fieldErrors(parsed.error));
    setErrors({});
    setBusy(true);
    try {
      await session.login(parsed.data);
      // The root layout swaps to the signed-in stack by itself.
    } catch (e) {
      setFormError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <FormScreen title="Log in">
      <Field
        label="Email or username"
        value={identifier}
        onChangeText={setIdentifier}
        error={errors.identifier}
        autoCapitalize="none"
        autoComplete="username"
        autoCorrect={false}
        textContentType="username"
        returnKeyType="next"
      />
      <Field
        label="Password"
        value={password}
        onChangeText={setPassword}
        error={errors.password}
        secureTextEntry
        autoComplete="current-password"
        textContentType="password"
        returnKeyType="go"
        onSubmitEditing={() => void submit()}
      />
      {formError ? <Notice kind="error">{formError}</Notice> : null}
      <Button title="Log in" busy={busy} onPress={() => void submit()} />
      <Button
        title="Forgot your password?"
        kind="link"
        onPress={() => router.push('/forgot-password')}
      />
      <Button title="Create an account" kind="link" onPress={() => router.push('/signup')} />
      {/* Which server this build talks to: the first thing to check when sign-in fails. Not shown
          in the production app, where it would just be noise. */}
      {config.variant !== 'production' ? (
        <Text selectable style={{ color: theme.muted, fontSize: 12, textAlign: 'center' }}>
          {config.variant} · {config.apiUrl}
        </Text>
      ) : null}
    </FormScreen>
  );
}
