import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  LAST_SEEN_VISIBILITY,
  THEME_PREFERENCES,
  changePasswordSchema,
  type LastSeenVisibility,
  type UpdateSettingsInput,
  type UserSettings,
} from '@videochat/shared';
import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useAuth } from '../../src/auth/AuthContext';
import {
  changePassword,
  fetchBlockedUsers,
  fetchMe,
  unblockUser,
  updateSettings,
} from '../../src/data/api';
import { keys } from '../../src/data/keys';
import { session } from '../../src/lib/api';
import { describeError } from '../../src/ui/describeError';
import { Button, Field, Notice } from '../../src/ui/Form';
import { useTheme } from '../../src/ui/theme';
import { setNoiseSuppression, useNoiseSuppression } from '../../src/calls/callPrefs';
import { fieldErrors } from '../../src/ui/useFormErrors';

const VISIBILITY_LABELS: Record<LastSeenVisibility, string> = {
  everyone: 'Everyone',
  contacts: 'People I chat with directly',
  nobody: 'Nobody',
};
const THEME_LABELS = { system: 'Match my device', light: 'Light', dark: 'Dark' } as const;

/** Bumped by every save: only the newest save's answer is applied, so two quick taps resolving out
 *  of order can't put the older state back. */
let latestSave = 0;

function mergeSettings(current: UserSettings, input: UpdateSettingsInput): UserSettings {
  return {
    ...current,
    ...(input.readReceipts !== undefined ? { readReceipts: input.readReceipts } : {}),
    ...(input.lastSeenVisibility !== undefined
      ? { lastSeenVisibility: input.lastSeenVisibility }
      : {}),
    ...(input.theme !== undefined ? { theme: input.theme } : {}),
    notifications: { ...current.notifications, ...input.notifications },
  };
}

function Heading({ children }: { children: string }) {
  const t = useTheme();
  return (
    <Text accessibilityRole="header" style={[styles.heading, { color: t.text }]}>
      {children}
    </Text>
  );
}

function ToggleRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  const t = useTheme();
  return (
    <View style={styles.rowBetween}>
      <Text style={{ color: t.text, fontSize: 16, flex: 1 }}>{label}</Text>
      <Switch accessibilityLabel={label} value={value} onValueChange={onChange} />
    </View>
  );
}

function Choice<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly [T, string][];
  value: T;
  onChange: (v: T) => void;
}) {
  const t = useTheme();
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} style={styles.choices}>
      {options.map(([v, text]) => (
        <Pressable
          key={v}
          accessibilityRole="radio"
          accessibilityState={{ selected: value === v }}
          onPress={() => onChange(v)}
          style={[
            styles.choice,
            { borderColor: value === v ? t.accent : t.border, backgroundColor: t.card },
          ]}
        >
          <Text style={{ color: value === v ? t.accent : t.text, fontWeight: '600' }}>{text}</Text>
        </Pressable>
      ))}
    </View>
  );
}

export default function Settings() {
  const t = useTheme();
  const noiseSuppression = useNoiseSuppression();
  const queryClient = useQueryClient();
  const { state } = useAuth();
  const user = state.status === 'signedIn' ? state.user : null;

  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pwMessage, setPwMessage] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [pwBusy, setPwBusy] = useState(false);

  const blocked = useQuery({ queryKey: keys.blocked, queryFn: fetchBlockedUsers });

  if (!user) return null;
  const s = user.settings;

  /** Saves at once, optimistically; on failure goes back to what the server actually has. */
  async function save(input: UpdateSettingsInput) {
    const mine = ++latestSave;
    const before = session.getUser();
    if (before) session.setUser({ ...before, settings: mergeSettings(before.settings, input) });
    try {
      const saved = await updateSettings(input);
      if (mine === latestSave) session.setUser(saved);
    } catch (e) {
      Alert.alert('Couldn’t save that setting', describeError(e));
      try {
        const fresh = await fetchMe();
        if (mine === latestSave) session.setUser(fresh);
      } catch {
        if (before && mine === latestSave) session.setUser(before);
      }
    }
  }

  async function submitPassword() {
    setPwMessage(null);
    const parsed = changePasswordSchema.safeParse({ currentPassword: current, newPassword: next });
    if (!parsed.success) return setErrors(fieldErrors(parsed.error));
    setErrors({});
    setPwBusy(true);
    try {
      await changePassword(parsed.data);
      setCurrent('');
      setNext('');
      setPwMessage({ kind: 'ok', text: 'Password changed. Other devices were signed out.' });
    } catch (e) {
      setPwMessage({ kind: 'error', text: describeError(e) });
    } finally {
      setPwBusy(false);
    }
  }

  return (
    <ScrollView
      style={{ backgroundColor: t.bg }}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
    >
      <Heading>Privacy</Heading>
      <ToggleRow
        label="Read receipts"
        value={s.readReceipts}
        onChange={(readReceipts) => void save({ readReceipts })}
      />
      <Text style={{ color: t.muted }}>Who can see when I was last online</Text>
      <Choice
        label="Last seen"
        value={s.lastSeenVisibility}
        options={LAST_SEEN_VISIBILITY.map((v) => [v, VISIBILITY_LABELS[v]] as [typeof v, string])}
        onChange={(lastSeenVisibility) => void save({ lastSeenVisibility })}
      />

      <Heading>Notifications</Heading>
      <ToggleRow
        label="Notifications"
        value={s.notifications.enabled}
        onChange={(enabled) => void save({ notifications: { enabled } })}
      />
      <ToggleRow
        label="Sound"
        value={s.notifications.sound}
        onChange={(sound) => void save({ notifications: { sound } })}
      />
      <ToggleRow
        label="Show message text"
        value={s.notifications.previews}
        onChange={(previews) => void save({ notifications: { previews } })}
      />
      <ToggleRow
        label="Mentions in muted chats"
        value={s.notifications.mentions}
        onChange={(mentions) => void save({ notifications: { mentions } })}
      />

      <Heading>Calls</Heading>
      <ToggleRow
        label="Noise suppression"
        value={noiseSuppression}
        onChange={(on) => void setNoiseSuppression(on)}
      />
      <Text style={{ color: t.muted, fontSize: 13 }}>
        Filters out background noise from your microphone on calls (this phone only). Takes effect
        on your next call.
      </Text>

      <Heading>Appearance</Heading>
      <Choice
        label="Theme"
        value={s.theme}
        options={THEME_PREFERENCES.map((v) => [v, THEME_LABELS[v]] as [typeof v, string])}
        onChange={(theme) => void save({ theme })}
      />

      <Heading>Change password</Heading>
      <Field
        label="Current password"
        value={current}
        onChangeText={setCurrent}
        secureTextEntry
        autoCapitalize="none"
        autoComplete="current-password"
        error={errors['currentPassword']}
      />
      <Field
        label="New password"
        value={next}
        onChangeText={setNext}
        secureTextEntry
        autoCapitalize="none"
        autoComplete="new-password"
        error={errors['newPassword']}
      />
      {pwMessage ? <Notice kind={pwMessage.kind}>{pwMessage.text}</Notice> : null}
      <Button title="Change password" busy={pwBusy} onPress={() => void submitPassword()} />

      <Heading>Blocked people</Heading>
      {blocked.data?.users.length === 0 ? (
        <Text style={{ color: t.muted }}>No one blocked.</Text>
      ) : null}
      {blocked.data?.users.map((u) => (
        <View key={u.id} style={styles.rowBetween}>
          <Text style={{ color: t.text, fontSize: 16 }}>
            {u.displayName} <Text style={{ color: t.muted }}>@{u.username}</Text>
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Unblock ${u.displayName}`}
            onPress={() =>
              void unblockUser(u.id)
                .then(() => queryClient.invalidateQueries({ queryKey: keys.blocked }))
                .catch((e: unknown) => Alert.alert('Couldn’t unblock', describeError(e)))
            }
          >
            <Text style={{ color: t.accent, fontWeight: '600' }}>Unblock</Text>
          </Pressable>
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  content: { padding: 20, gap: 12 },
  heading: { fontSize: 18, fontWeight: '700', marginTop: 12 },
  rowBetween: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  choices: { gap: 8 },
  choice: { borderWidth: 1, borderRadius: 10, paddingVertical: 12, paddingHorizontal: 14 },
});
