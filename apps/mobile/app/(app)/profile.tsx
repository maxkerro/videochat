import { displayNameSchema } from '@videochat/shared';
import { useRouter } from 'expo-router';
import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useAuth } from '../../src/auth/AuthContext';
import { updateProfile, uploadAvatar } from '../../src/data/api';
import { session } from '../../src/lib/api';
import { Avatar } from '../../src/ui/Avatar';
import { describeError } from '../../src/ui/describeError';
import { Button, Field, Notice } from '../../src/ui/Form';
import { useTheme } from '../../src/ui/theme';

export default function Profile() {
  const t = useTheme();
  const router = useRouter();
  const { state, logout } = useAuth();
  const user = state.status === 'signedIn' ? state.user : null;
  const [name, setName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  if (!user) return null;

  const shown = name ?? user.displayName;
  const dirty = name !== null && name.trim() !== user.displayName;

  async function save() {
    const parsed = displayNameSchema.safeParse(shown);
    if (!parsed.success)
      return setMessage({ kind: 'error', text: 'Enter a name up to 64 characters' });
    setBusy(true);
    setMessage(null);
    try {
      session.setUser(await updateProfile({ displayName: parsed.data }));
      setName(null);
      setMessage({ kind: 'ok', text: 'Saved' });
    } catch (e) {
      setMessage({ kind: 'error', text: describeError(e) });
    } finally {
      setBusy(false);
    }
  }

  async function changeAvatar() {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.8,
      });
      const asset = result.assets?.[0];
      if (result.canceled || !asset) return;
      setBusy(true);
      session.setUser(
        await uploadAvatar({
          uri: asset.uri,
          name: asset.fileName ?? 'avatar.jpg',
          type: asset.mimeType ?? 'image/jpeg',
        }),
      );
    } catch (e) {
      Alert.alert('Couldn’t update the photo', describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ScrollView
      style={{ backgroundColor: t.bg }}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Change photo"
        onPress={() => void changeAvatar()}
        style={styles.avatar}
      >
        <Avatar name={user.displayName} uri={user.avatarUrl} size={96} />
        <Text style={{ color: t.accent, fontWeight: '600' }}>Change photo</Text>
      </Pressable>
      <Field label="Display name" value={shown} onChangeText={setName} maxLength={64} />
      <View style={styles.facts}>
        <Text style={{ color: t.muted }}>Username: @{user.username}</Text>
        <Text style={{ color: t.muted }}>
          Email: {user.email}
          {user.emailVerified ? '' : ' (not verified)'}
        </Text>
      </View>
      {message ? <Notice kind={message.kind}>{message.text}</Notice> : null}
      {dirty ? <Button title="Save" busy={busy} onPress={() => void save()} /> : null}
      <Button title="Settings" kind="link" onPress={() => router.push('/settings')} />
      <Button title="Log out" kind="link" onPress={() => void logout()} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 24, gap: 16 },
  avatar: { alignItems: 'center', gap: 8 },
  facts: { gap: 4 },
});
