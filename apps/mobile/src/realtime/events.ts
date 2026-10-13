import {
  conversationReadEventSchema,
  messageReactionsSchema,
  messageSchema,
  presenceSchema,
  typingEventSchema,
  type ConversationSummary,
  type MemberSummary,
  type Presence,
  type WsEnvelope,
} from '@videochat/shared';
import { keys } from '../data/keys';
import { mergeMessages, setReactions, type MessagesState } from '../data/messagesState';
import { queryClient, sameSession } from '../data/queryClient';
import { getLocalStore } from '../db/expoDb';
import { clearTyping, noteTyping } from './typing';

export interface EventContext {
  /** The signed-in user. */
  myId: string;
  /** The session generation the socket belongs to; events from an older session are dropped. */
  generation: number;
}

const INBOX_REFRESH_MIN_MS = 1_000;
let lastInboxRefresh = 0;
let inboxTimer: ReturnType<typeof setTimeout> | undefined;

/** Re-reads the inbox (previews, unread counts, order) -- at most about once a second however many
 *  messages arrive, with the last request always honoured. */
export function refreshInbox(now: number = Date.now()): void {
  const run = () => {
    lastInboxRefresh = Date.now();
    inboxTimer = undefined;
    void queryClient.invalidateQueries({ queryKey: keys.conversations });
  };
  if (inboxTimer !== undefined) return;
  const wait = lastInboxRefresh + INBOX_REFRESH_MIN_MS - now;
  if (wait <= 0) run();
  else inboxTimer = setTimeout(run, wait);
}

export function resetInboxThrottle(): void {
  if (inboxTimer !== undefined) clearTimeout(inboxTimer);
  inboxTimer = undefined;
  lastInboxRefresh = 0;
}

// Live messages only extend the on-device copy when they join it without a gap (see appendLive).
const saveLocally = (conversationId: string, messages: Parameters<typeof mergeMessages>[1]) =>
  void getLocalStore()
    .then((s) => s.appendLive(conversationId, messages))
    .catch(() => undefined);

/**
 * CHAT-054: applies one realtime event to what the screens show -- the same caches the REST calls
 * fill, so a screen needs no idea whether an update came from the socket or from a refetch. Events
 * from a session that has since ended are dropped. Anything that doesn't fit what's cached (a
 * message that skips ahead of the newest one we hold) triggers a normal refetch instead of
 * guessing, so the list can never show a hole.
 */
export function applyRealtimeEvent(envelope: WsEnvelope, ctx: EventContext): void {
  if (!sameSession(ctx.generation)) return;
  switch (envelope.type) {
    case 'message.new': {
      const parsed = messageSchema.safeParse(envelope.payload);
      if (!parsed.success) return;
      const message = parsed.data;
      const key = keys.messages(message.conversationId);
      const cached = queryClient.getQueryData<MessagesState>(key);
      const newest = cached?.messages.at(-1)?.seq;
      if (cached && newest !== undefined && message.seq > newest + 1) {
        void queryClient.invalidateQueries({ queryKey: key });
      } else {
        if (cached) queryClient.setQueryData<MessagesState>(key, mergeMessages(cached, [message]));
        saveLocally(message.conversationId, [message]);
      }
      if (message.senderId) clearTyping(message.conversationId, message.senderId);
      void queryClient.invalidateQueries({ queryKey: keys.conversation(message.conversationId) });
      refreshInbox();
      return;
    }
    case 'message.updated': {
      const parsed = messageSchema.safeParse(envelope.payload);
      if (!parsed.success) return;
      const message = parsed.data;
      queryClient.setQueryData<MessagesState>(keys.messages(message.conversationId), (old) =>
        old?.messages.some((m) => m.id === message.id) ? mergeMessages(old, [message]) : old,
      );
      saveLocally(message.conversationId, [message]);
      // The inbox preview shows the edited or deleted text.
      refreshInbox();
      return;
    }
    case 'message.reactions': {
      const parsed = messageReactionsSchema.safeParse(envelope.payload);
      if (!parsed.success) return;
      const { conversationId, messageId, reactions } = parsed.data;
      queryClient.setQueryData<MessagesState>(keys.messages(conversationId), (old) =>
        setReactions(old, messageId, reactions),
      );
      return;
    }
    case 'conversation.read': {
      const parsed = conversationReadEventSchema.safeParse(envelope.payload);
      if (!parsed.success) return;
      const { conversationId, userId, lastReadSeq } = parsed.data;
      const patch = (c: ConversationSummary): ConversationSummary => {
        if (userId === ctx.myId) return { ...c, lastReadSeq };
        return c.peer?.id === userId ? { ...c, peerLastReadSeq: lastReadSeq } : c;
      };
      queryClient.setQueryData<ConversationSummary>(keys.conversation(conversationId), (old) =>
        old ? patch(old) : old,
      );
      queryClient.setQueryData<ConversationSummary[]>(keys.conversations, (old) =>
        old?.map((c) => (c.id === conversationId ? patch(c) : c)),
      );
      queryClient.setQueryData<MemberSummary[]>(keys.members(conversationId), (old) =>
        old?.map((m) => (m.userId === userId ? { ...m, lastReadSeq } : m)),
      );
      return;
    }
    case 'conversation.typing': {
      const parsed = typingEventSchema.safeParse(envelope.payload);
      if (!parsed.success || parsed.data.userId === ctx.myId) return;
      noteTyping(parsed.data.conversationId, parsed.data.userId, parsed.data.displayName);
      return;
    }
    case 'presence.changed': {
      const parsed = presenceSchema.safeParse(envelope.payload);
      if (!parsed.success) return;
      const next = parsed.data;
      queryClient.setQueriesData<Presence[]>({ queryKey: ['presence'] }, (list) =>
        list?.some((p) => p.userId === next.userId)
          ? list.map((p) => (p.userId === next.userId ? next : p))
          : list,
      );
      return;
    }
    default:
      return;
  }
}

/** After (re)connecting or returning to the app: re-read what could have changed meanwhile. The
 *  messages query merges the newest page into what is cached and notices a hole by itself. */
export function catchUp(): void {
  void queryClient.invalidateQueries({ queryKey: keys.conversations });
  void queryClient.invalidateQueries({ queryKey: ['conversation'] });
  void queryClient.invalidateQueries({ queryKey: ['messages'] });
  void queryClient.invalidateQueries({ queryKey: ['presence'] });
}
