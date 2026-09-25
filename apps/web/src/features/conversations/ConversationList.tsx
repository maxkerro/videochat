import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  conversationReadEventSchema,
  messageSchema,
  type ConversationSummary,
  type WsEnvelope,
} from '@videochat/shared';
import { useState } from 'react';
import { NavLink } from 'react-router';
import { Avatar, Input, Menu } from '../../components/ui';
import { useAuth, withAuthRetry } from '../auth/AuthContext';
import { useRealtimeEvent } from '../chat/RealtimeProvider';
import { cx } from '../../lib/cx';
import { fetchConversations, markConversationUnread } from './conversationsApi';
import styles from './ConversationList.module.css';

function titleFor(conversation: ConversationSummary): string {
  return conversation.peer?.displayName ?? conversation.title ?? 'Conversation';
}

function timeFor(conversation: ConversationSummary): string {
  if (!conversation.lastMessageAt) return '';
  return new Date(conversation.lastMessageAt).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Same ordering the API returns the list in (most recent activity first), so a client-side
 *  reorder after a realtime update never disagrees with a fresh fetch. A conversation with no
 *  messages yet (`lastMessageAt: null`) sorts last. */
function byRecency(a: ConversationSummary, b: ConversationSummary): number {
  const at = a.lastMessageAt ? Date.parse(a.lastMessageAt) : 0;
  const bt = b.lastMessageAt ? Date.parse(b.lastMessageAt) : 0;
  return bt - at;
}

export function ConversationList() {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [query, setQuery] = useState('');

  const { data: conversations = [] } = useQuery({
    queryKey: ['conversations'],
    queryFn: () => withAuthRetry(auth, fetchConversations),
    enabled: auth.status === 'authenticated',
  });

  // CHAT-015: keeps the inbox live -- a new message (ours or a peer's) moves its conversation to
  // the top and updates the unread badge immediately, without waiting on a refetch.
  useRealtimeEvent((envelope: WsEnvelope) => {
    if (envelope.type !== 'message.new') return;
    const parsed = messageSchema.safeParse(envelope.payload);
    if (!parsed.success) return;
    const message = parsed.data;

    const old = queryClient.getQueryData<ConversationSummary[]>(['conversations']);
    if (!old) return;
    const idx = old.findIndex((c) => c.id === message.conversationId);
    if (idx < 0) {
      // Not a conversation we have cached yet -- most likely one just started by someone else
      // that immediately sent a message. Refetch instead of fabricating a summary client-side.
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
      return;
    }
    // A duplicate or out-of-order delivery (reconnect replay, a retried publish) must never
    // move the conversation's timestamp backwards or re-sort the list -- only a message that is
    // actually newer than what we've already applied should change anything here.
    if (message.seq <= old[idx]!.lastSeq) return;

    // A live event can race an in-flight fetch of this same list (e.g. a window-focus refetch)
    // whose response was computed before this message was persisted; without cancelling it,
    // that stale response could land after our update below and silently undo the bump.
    void queryClient.cancelQueries({ queryKey: ['conversations'] });

    queryClient.setQueryData<ConversationSummary[]>(['conversations'], (list) => {
      if (!list) return list;
      const i = list.findIndex((c) => c.id === message.conversationId);
      if (i < 0) return list;
      const current = list[i]!;
      if (message.seq <= current.lastSeq) return list;
      const next: ConversationSummary = {
        ...current,
        lastSeq: message.seq,
        lastMessageAt: message.createdAt,
        // Sending counts as having read your own message (mirrors appendMessage's own
        // bookkeeping server-side), so your own outgoing messages never show up as unread here.
        lastReadSeq: message.senderId === auth.user?.id ? message.seq : current.lastReadSeq,
      };
      const copy = list.slice();
      copy[i] = next;
      copy.sort(byRecency);
      return copy;
    });
  });

  // CHAT-019: keeps the unread badge in sync across this person's own open devices/tabs -- their
  // own read position advancing (or being reset by "mark as unread") elsewhere is applied here
  // directly, without a refetch. A `conversation.read` event for a *different* user (another
  // member's read position, relevant to a group's "Seen by N") is ignored here on purpose: it
  // never affects *this* person's own unread count.
  useRealtimeEvent((envelope: WsEnvelope) => {
    if (envelope.type !== 'conversation.read') return;
    const parsed = conversationReadEventSchema.safeParse(envelope.payload);
    if (!parsed.success) return;
    const event = parsed.data;
    if (event.userId !== auth.user?.id) return;

    queryClient.setQueryData<ConversationSummary[]>(['conversations'], (list) =>
      list?.map((c) =>
        c.id === event.conversationId ? { ...c, lastReadSeq: event.lastReadSeq } : c,
      ),
    );
  });

  // CHAT-019: "Mark as unread" from each conversation's menu. Optimistic -- the badge reappears
  // immediately rather than waiting on the round trip -- and reconciled with the server's actual
  // response on success (in case its "one less than lastSeq" semantics differ from a naive guess,
  // e.g. a message arrived between the click and the response). A failure rolls the cache back to
  // its pre-mutation snapshot, matching the optimistic-update pattern react-query itself
  // documents.
  const markUnread = useMutation({
    mutationFn: (conversationId: string) =>
      withAuthRetry(auth, (token) => markConversationUnread(token, conversationId)),
    onMutate: async (conversationId: string) => {
      await queryClient.cancelQueries({ queryKey: ['conversations'] });
      const previous = queryClient.getQueryData<ConversationSummary[]>(['conversations']);
      queryClient.setQueryData<ConversationSummary[]>(['conversations'], (list) =>
        list?.map((c) =>
          c.id === conversationId ? { ...c, lastReadSeq: Math.max(c.lastSeq - 1, 0) } : c,
        ),
      );
      return { previous };
    },
    onError: (_err, _conversationId, context) => {
      if (context?.previous) queryClient.setQueryData(['conversations'], context.previous);
    },
    onSuccess: (summary) => {
      queryClient.setQueryData<ConversationSummary[]>(['conversations'], (list) =>
        list?.map((c) => (c.id === summary.id ? summary : c)),
      );
    },
  });

  const items = conversations.filter((c) =>
    titleFor(c).toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <div className={styles.wrap}>
      <div className={styles.search}>
        <Input
          label="Search conversations"
          hideLabel
          type="search"
          placeholder="Search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          leading={
            <svg width="16" height="16" viewBox="0 0 24 24">
              <circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" strokeWidth="2" />
              <path
                d="M20 20l-3.5-3.5"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          }
        />
      </div>
      <nav aria-label="Conversations" className={styles.scroll}>
        {items.length === 0 ? (
          <p className={styles.empty}>
            {query
              ? `No conversations match "${query}".`
              : 'No conversations yet -- start one with "New chat".'}
          </p>
        ) : (
          <ul className={styles.list}>
            {items.map((c) => {
              const unread = Math.max(0, c.lastSeq - c.lastReadSeq);
              return (
                <li key={c.id} className={styles.itemRow}>
                  <NavLink
                    to={`/c/${c.id}`}
                    className={({ isActive }) => cx(styles.item, isActive && styles.active)}
                  >
                    <Avatar name={titleFor(c)} src={c.peer?.avatarUrl} />
                    <span className={styles.text}>
                      <span className={styles.row}>
                        <span className={styles.title}>{titleFor(c)}</span>
                        <time className={styles.time}>{timeFor(c)}</time>
                      </span>
                      {unread > 0 && (
                        <span className={styles.row}>
                          <span className={styles.preview} />
                          <span className={styles.badge} aria-label={`${unread} unread`}>
                            {unread > 99 ? '99+' : unread}
                          </span>
                        </span>
                      )}
                    </span>
                  </NavLink>
                  {/* CHAT-019: AC "Mark as unread is available from the conversation menu". */}
                  <Menu
                    trigger={
                      <button
                        type="button"
                        className={styles.menuTrigger}
                        aria-label={`More options for ${titleFor(c)}`}
                      >
                        ⋮
                      </button>
                    }
                    items={[
                      {
                        label: 'Mark as unread',
                        onSelect: () => markUnread.mutate(c.id),
                        disabled: c.lastSeq === 0,
                      },
                    ]}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </nav>
    </div>
  );
}
