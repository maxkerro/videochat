import { useQuery } from '@tanstack/react-query';
import { LIMITS, type PublicUser } from '@videochat/shared';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { createGroup, startDirect } from '../../src/data/actions';
import { searchUsers } from '../../src/data/api';
import { Avatar } from '../../src/ui/Avatar';
import { describeError } from '../../src/ui/describeError';
import { Button } from '../../src/ui/Form';
import { useTheme } from '../../src/ui/theme';

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

export default function NewChat() {
  const t = useTheme();
  const router = useRouter();
  const [group, setGroup] = useState(false);
  const [text, setText] = useState('');
  const [title, setTitle] = useState('');
  const [picked, setPicked] = useState<PublicUser[]>([]);
  const [busy, setBusy] = useState(false);
  const q = useDebounced(text.trim(), 300);

  const results = useQuery({
    queryKey: ['user-search', q],
    queryFn: () => searchUsers(q),
    enabled: q.length > 0,
    staleTime: 30_000,
  });

  async function open(user: PublicUser) {
    if (busy) return;
    if (group) {
      setPicked((p) =>
        p.some((x) => x.id === user.id) ? p.filter((x) => x.id !== user.id) : [...p, user],
      );
      return;
    }
    setBusy(true);
    try {
      const c = await startDirect(user.id);
      router.replace(`/c/${c.id}`);
    } catch (e) {
      Alert.alert('Couldn’t start the chat', describeError(e));
      setBusy(false);
    }
  }

  async function create() {
    if (busy) return;
    if (!title.trim()) return Alert.alert('Give the group a name');
    if (picked.length === 0) return Alert.alert('Pick at least one person');
    setBusy(true);
    try {
      const c = await createGroup(
        title.trim(),
        picked.map((u) => u.id),
      );
      router.replace(`/c/${c.id}`);
    } catch (e) {
      Alert.alert('Couldn’t create the group', describeError(e));
      setBusy(false);
    }
  }

  const pickedIds = new Set(picked.map((u) => u.id));
  return (
    <KeyboardAvoidingView
      style={[styles.flex, { backgroundColor: t.bg }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.tabs}>
        {[false, true].map((g) => (
          <Pressable
            key={String(g)}
            accessibilityRole="tab"
            accessibilityState={{ selected: group === g }}
            onPress={() => setGroup(g)}
            style={[styles.tab, { borderBottomColor: group === g ? t.accent : 'transparent' }]}
          >
            <Text style={{ color: group === g ? t.accent : t.muted, fontWeight: '600' }}>
              {g ? 'New group' : 'Direct message'}
            </Text>
          </Pressable>
        ))}
      </View>
      {group ? (
        <TextInput
          accessibilityLabel="Group name"
          value={title}
          onChangeText={setTitle}
          maxLength={LIMITS.groupTitleMax}
          placeholder="Group name"
          placeholderTextColor={t.muted}
          style={[styles.input, { color: t.text, backgroundColor: t.card, borderColor: t.border }]}
        />
      ) : null}
      {group && picked.length > 0 ? (
        <Text style={[styles.picked, { color: t.text }]}>
          {picked.map((u) => u.displayName).join(', ')}
        </Text>
      ) : null}
      <TextInput
        accessibilityLabel="Find people by name, username or email"
        value={text}
        onChangeText={setText}
        autoCapitalize="none"
        autoCorrect={false}
        placeholder="Find people by name, username or email"
        placeholderTextColor={t.muted}
        style={[styles.input, { color: t.text, backgroundColor: t.card, borderColor: t.border }]}
      />
      {results.isFetching ? <ActivityIndicator style={styles.spinner} /> : null}
      <FlatList
        data={results.data?.users ?? []}
        keyExtractor={(u) => u.id}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: pickedIds.has(item.id) }}
            onPress={() => void open(item)}
            style={[styles.row, { borderBottomColor: t.border }]}
          >
            <Avatar name={item.displayName} uri={item.avatarUrl} size={40} />
            <View style={styles.flex}>
              <Text style={{ color: t.text, fontWeight: '600' }}>{item.displayName}</Text>
              <Text style={{ color: t.muted }}>@{item.username}</Text>
            </View>
            {group ? (
              <Text style={{ color: t.accent, fontSize: 20 }}>
                {pickedIds.has(item.id) ? '✓' : ''}
              </Text>
            ) : null}
          </Pressable>
        )}
        ListEmptyComponent={
          q.length > 0 && !results.isFetching ? (
            <Text style={[styles.hint, { color: t.muted }]}>
              {results.isError ? describeError(results.error) : 'No one found.'}
            </Text>
          ) : null
        }
      />
      {group ? (
        <View style={styles.footer}>
          <Button
            title={`Create group${picked.length ? ` (${picked.length})` : ''}`}
            busy={busy}
            onPress={() => void create()}
          />
        </View>
      ) : null}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  tabs: { flexDirection: 'row' },
  tab: { flex: 1, alignItems: 'center', paddingVertical: 12, borderBottomWidth: 2 },
  input: {
    margin: 12,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
  },
  picked: { marginHorizontal: 16, fontSize: 14 },
  spinner: { margin: 8 },
  row: {
    flexDirection: 'row',
    gap: 12,
    padding: 12,
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  hint: { textAlign: 'center', padding: 24 },
  footer: { padding: 12 },
});
