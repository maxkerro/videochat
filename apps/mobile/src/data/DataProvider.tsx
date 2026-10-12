import NetInfo from '@react-native-community/netinfo';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ConversationSummary } from '@videochat/shared';
import { useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, AppState, View } from 'react-native';
import { useAuth } from '../auth/AuthContext';
import { getLocalStore } from '../db/expoDb';
import { session } from '../lib/api';
import { useTheme } from '../ui/theme';
import { keys } from './keys';
import { outboxRunner } from './outboxRunner';
import { queryClient, sameSession } from './queryClient';

/** How often a stuck outbox is retried while the app is open (on top of every reconnect/resume). */
const OUTBOX_RETRY_MS = 20_000;

/**
 * CHAT-053: opens the on-device store for the signed-in user. If the cache belongs to a different
 * account it is wiped first; otherwise the cached inbox is put into the query cache so the first
 * frame already has content, even with no network. It also keeps the outbox flowing: it is flushed
 * on start, whenever the app returns to the foreground, whenever the connection comes back, and
 * periodically while anything is still waiting.
 */
export function DataProvider({ children }: { children: ReactNode }) {
  const { state } = useAuth();
  const userId = state.status === 'signedIn' ? state.user.id : null;
  const [readyFor, setReadyFor] = useState<string | null>(null);
  const t = useTheme();

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    const startedAt = session.generation();
    void (async () => {
      try {
        const store = await getLocalStore();
        if ((await store.getOwner()) !== userId) {
          await store.wipe();
          await store.setOwner(userId);
        } else if (!queryClient.getQueryData(keys.conversations)) {
          const cached = await store.loadConversations();
          if (cached.length > 0 && sameSession(startedAt)) {
            queryClient.setQueryData<ConversationSummary[]>(keys.conversations, cached, {
              updatedAt: 0,
            });
          }
        }
      } catch {
        // No usable local database: the app still works online, just without the cache.
      }
      if (!cancelled) setReadyFor(userId);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const ready = userId !== null && readyFor === userId;

  useEffect(() => {
    if (!ready) return;
    const flush = () => void outboxRunner.flush().catch(() => undefined);
    flush();
    const appSub = AppState.addEventListener('change', (s) => s === 'active' && flush());
    let wasOnline = true;
    const netUnsub = NetInfo.addEventListener((s) => {
      const online = s.isConnected !== false;
      if (online && !wasOnline) flush();
      wasOnline = online;
    });
    const timer = setInterval(flush, OUTBOX_RETRY_MS);
    return () => {
      appSub.remove();
      netUnsub();
      clearInterval(timer);
    };
  }, [ready]);

  if (!ready) {
    return (
      <View
        style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: t.bg }}
      >
        <ActivityIndicator accessibilityLabel="Loading" />
      </View>
    );
  }
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
