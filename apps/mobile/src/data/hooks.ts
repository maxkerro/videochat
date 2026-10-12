import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import type { ConversationSummary, MemberSummary } from '@videochat/shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getLocalStore } from '../db/expoDb';
import type { OutboxItem } from '../db/store';
import { session } from '../lib/api';
import * as api from './api';
import { keys } from './keys';
import { mergeLatestPage, prependOlder, type MessagesState } from './messagesState';
import { queryClient, sameSession } from './queryClient';
import { useLiveInterval } from './useLive';

const bestEffort = (p: Promise<unknown>) => void p.catch(() => undefined);

/** The inbox. Shows the on-device copy at once, then the server's list. */
export function useConversations(): UseQueryResult<ConversationSummary[]> {
  const refetchInterval = useLiveInterval(15_000);
  return useQuery({
    queryKey: keys.conversations,
    refetchInterval,
    queryFn: async () => {
      const startedAt = session.generation();
      const list = await api.fetchConversations();
      if (sameSession(startedAt)) {
        bestEffort(getLocalStore().then((s) => s.saveConversations(list)));
      }
      return list;
    },
  });
}

/** One conversation, refreshed often while it is open (the peer's read position, the title ...). */
export function useConversation(id: string): UseQueryResult<ConversationSummary> {
  const refetchInterval = useLiveInterval(6_000);
  return useQuery({
    queryKey: keys.conversation(id),
    refetchInterval,
    // The inbox list usually has it already: show that while the fresh copy loads.
    placeholderData: () =>
      queryClient.getQueryData<ConversationSummary[]>(keys.conversations)?.find((c) => c.id === id),
    queryFn: async () => {
      const startedAt = session.generation();
      const summary = await api.fetchConversation(id);
      if (sameSession(startedAt)) {
        bestEffort(getLocalStore().then((s) => s.upsertConversation(summary)));
      }
      return summary;
    },
  });
}

export function useMembers(id: string, enabled = true): UseQueryResult<MemberSummary[]> {
  return useQuery({ queryKey: keys.members(id), enabled, queryFn: () => api.fetchMembers(id) });
}

export interface MessagesView {
  state: MessagesState | undefined;
  /** True until there is anything to show: neither the on-device copy nor the server answered. */
  isLoading: boolean;
  error: unknown;
  loadingOlder: boolean;
  loadOlder: () => Promise<void>;
}

const HYDRATE_COUNT = 200;

/**
 * A conversation's messages: the on-device copy appears immediately (even offline), the newest
 * server page replaces it, and while the screen is open the newest page is re-read every few
 * seconds so new messages, edits, deletes and reactions show up (CHAT-054 swaps this for the socket).
 */
export function useMessages(id: string): MessagesView {
  const key = keys.messages(id);
  const refetchInterval = useLiveInterval(6_000);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const busy = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const startedAt = session.generation();
    void getLocalStore()
      .then((s) => s.loadMessages(id, HYDRATE_COUNT))
      .then((messages) => {
        if (cancelled || !sameSession(startedAt) || messages.length === 0) return;
        if (queryClient.getQueryData(key)) return; // the server answered first
        queryClient.setQueryData<MessagesState>(key, { messages, hasMore: true }, { updatedAt: 0 });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [id, key]);

  const query = useQuery({
    queryKey: key,
    refetchInterval,
    queryFn: async (): Promise<MessagesState> => {
      const startedAt = session.generation();
      const page = await api.fetchMessages(id);
      if (sameSession(startedAt)) {
        bestEffort(getLocalStore().then((s) => s.saveMessages(id, page.messages)));
      }
      return mergeLatestPage(queryClient.getQueryData<MessagesState>(key), page);
    },
  });

  const loadOlder = useCallback(async () => {
    const current = queryClient.getQueryData<MessagesState>(key);
    const oldest = current?.messages[0];
    if (!current || !oldest || !current.hasMore || busy.current) return;
    busy.current = true;
    setLoadingOlder(true);
    const startedAt = session.generation();
    try {
      const page = await api.fetchMessages(id, oldest.seq);
      // The account may have changed while the page was in flight (the cache was cleared then):
      // writing now would resurrect the old account's messages in a fresh cache entry.
      if (!sameSession(startedAt)) return;
      queryClient.setQueryData<MessagesState>(key, (old) => prependOlder(old, page));
      bestEffort(getLocalStore().then((s) => s.saveMessages(id, page.messages)));
    } catch {
      // offline or a hiccup: the next scroll to the top tries again
    } finally {
      busy.current = false;
      setLoadingOlder(false);
    }
  }, [id, key]);

  return {
    state: query.data,
    isLoading: query.isPending && query.data === undefined,
    error: query.error,
    loadingOlder,
    loadOlder,
  };
}

/** Messages typed in this conversation that the server has not confirmed yet. */
export function useOutbox(conversationId: string): OutboxItem[] {
  const { data } = useQuery({
    queryKey: keys.outbox(conversationId),
    queryFn: async () => (await getLocalStore()).listOutbox(conversationId),
    staleTime: 0,
    gcTime: 0,
  });
  return data ?? [];
}
