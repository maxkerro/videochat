import { useInfiniteQuery } from '@tanstack/react-query';
import {
  snippetParts,
  type ConversationSummary,
  type SearchHas,
  type SearchResult,
} from '@videochat/shared';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as api from '../../src/data/api';
import { useConversations } from '../../src/data/hooks';
import {
  afterFor,
  HAS_OPTIONS,
  MIN_SEARCH_LENGTH,
  WHEN_OPTIONS,
  type SearchWhen,
} from '../../src/data/search';
import { describeError } from '../../src/ui/describeError';
import { conversationTitle, formatListTime } from '../../src/ui/format';
import { useTheme } from '../../src/ui/theme';

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

function Chip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={[
        styles.chip,
        { borderColor: selected ? t.accent : t.border },
        selected && { backgroundColor: t.accent },
      ]}
    >
      <Text style={{ color: selected ? t.accentText : t.text, fontSize: 13 }}>{label}</Text>
    </Pressable>
  );
}

function ResultRow({
  result,
  conversation,
  onOpen,
}: {
  result: SearchResult;
  conversation: ConversationSummary | undefined;
  onOpen: () => void;
}) {
  const t = useTheme();
  const { message, senderName, snippet } = result;
  const where = conversation ? conversationTitle(conversation) : 'Chat';
  const who = conversation?.type === 'group' && senderName ? ` · ${senderName}` : '';
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onOpen}
      style={[styles.row, { borderBottomColor: t.border }]}
    >
      <View style={styles.line}>
        <Text numberOfLines={1} style={[styles.where, { color: t.text }]}>
          {where}
          {who}
        </Text>
        <Text style={{ color: t.muted, fontSize: 12 }}>{formatListTime(message.createdAt)}</Text>
      </View>
      {message.attachment ? (
        <Text numberOfLines={1} style={{ color: t.muted, fontSize: 13 }}>
          📎 {message.attachment.filename}
        </Text>
      ) : null}
      <Text numberOfLines={3} style={{ color: t.text, fontSize: 14 }}>
        {snippetParts(snippet).map((part, i) =>
          part.match ? (
            <Text key={i} style={{ fontWeight: '700', color: t.accent }}>
              {part.text}
            </Text>
          ) : (
            part.text
          ),
        )}
      </Text>
    </Pressable>
  );
}

/**
 * CHAT-072: message and file search across every chat (or one, opened from its info screen as
 * `/search?in=<id>`). A result opens its chat scrolled to that message.
 */
export default function SearchScreen() {
  const t = useTheme();
  const router = useRouter();
  const params = useLocalSearchParams<{ in?: string }>();
  const conversations = useConversations();
  const [text, setText] = useState('');
  const [inConversation, setInConversation] = useState(params.in ?? '');
  const [period, setPeriod] = useState<SearchWhen>('any');
  const [has, setHas] = useState<SearchHas | ''>('');
  const q = useDebounced(text.trim(), 300);

  const byId = useMemo(
    () => new Map((conversations.data ?? []).map((c) => [c.id, c])),
    [conversations.data],
  );
  const scoped = inConversation ? byId.get(inConversation) : undefined;

  const enabled = q.length >= MIN_SEARCH_LENGTH;
  const results = useInfiniteQuery({
    queryKey: ['search', q, inConversation, period, has],
    queryFn: ({ pageParam }) =>
      api.searchMessages({
        q,
        conversationId: inConversation || undefined,
        after: afterFor(period),
        has: has || undefined,
        cursor: pageParam,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled,
    staleTime: 10_000,
  });
  const found = results.data?.pages.flatMap((p) => p.results) ?? [];
  const waiting = text.trim() !== q || (enabled && results.isPending);

  return (
    <View style={[styles.flex, { backgroundColor: t.bg }]}>
      <Stack.Screen
        options={{ title: scoped ? `Search in ${conversationTitle(scoped)}` : 'Search' }}
      />
      <TextInput
        accessibilityLabel="Search messages"
        placeholder="Search messages and files"
        placeholderTextColor={t.muted}
        value={text}
        onChangeText={setText}
        autoFocus
        autoCorrect={false}
        returnKeyType="search"
        style={[styles.input, { color: t.text, backgroundColor: t.card, borderColor: t.border }]}
      />
      <View style={styles.chips}>
        {HAS_OPTIONS.map((o) => (
          <Chip
            key={o.value || 'all'}
            label={o.label}
            selected={has === o.value}
            onPress={() => setHas(o.value)}
          />
        ))}
      </View>
      <View style={styles.chips}>
        {WHEN_OPTIONS.map((o) => (
          <Chip
            key={o.value}
            label={o.label}
            selected={period === o.value}
            onPress={() => setPeriod(o.value)}
          />
        ))}
        {scoped ? (
          <Chip label="All chats" selected={false} onPress={() => setInConversation('')} />
        ) : null}
      </View>
      {!enabled ? (
        <Text style={[styles.note, { color: t.muted }]}>
          Type at least {MIN_SEARCH_LENGTH} characters.
        </Text>
      ) : results.isError ? (
        <Text style={[styles.note, { color: t.error }]}>{describeError(results.error)}</Text>
      ) : waiting ? (
        <ActivityIndicator style={styles.note} accessibilityLabel="Searching" />
      ) : (
        <FlatList
          data={found}
          keyExtractor={(r) => r.message.id}
          keyboardShouldPersistTaps="handled"
          renderItem={({ item }) => (
            <ResultRow
              result={item}
              conversation={byId.get(item.message.conversationId)}
              onOpen={() => router.push(`/c/${item.message.conversationId}?msg=${item.message.id}`)}
            />
          )}
          onEndReached={() => {
            if (results.hasNextPage && !results.isFetchingNextPage) void results.fetchNextPage();
          }}
          onEndReachedThreshold={0.5}
          ListFooterComponent={
            results.isFetchingNextPage ? <ActivityIndicator style={styles.note} /> : null
          }
          ListEmptyComponent={
            <Text style={[styles.note, { color: t.muted }]}>No messages match “{q}”.</Text>
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  input: {
    margin: 12,
    marginBottom: 6,
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  chip: { borderWidth: 1, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 4 },
  note: { padding: 24, textAlign: 'center' },
  row: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 2,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  line: { flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  where: { flex: 1, fontWeight: '600', fontSize: 15 },
});
