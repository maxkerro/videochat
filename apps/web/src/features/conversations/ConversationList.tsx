import { useQuery, useQueryClient } from '@tanstack/react-query';
import { messageSchema, type ConversationSummary, type WsEnvelope } from '@videochat/shared';
import { useState } from 'react';
import { NavLink } from 'react-router';
import { Avatar, Input } from '../../components/ui';
import { useAuth, withAuthRetry } from '../auth/AuthContext';
import { useRealtimeEvent } from '../chat/RealtimeProvider';
import { cx } from '../../lib/cx';
import { fetchConversations } from './conversationsApi';
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

    queryClient.setQueryData<ConversationSummary[]>(['conversations'], (old) => {
      if (!old) return old;
      const idx = old.findIndex((c) => c.id === message.conversationId);
      if (idx < 0) {
        // Not a conversation we have cached yet -- most likely one just started by someone else
        // that immediately sent a message. Refetch instead of fabricating a summary client-side.
        void queryClient.invalidateQueries({ queryKey: ['conversations'] });
        return old;
      }
      const current = old[idx]!;
      const next: ConversationSummary = {
        ...current,
        lastSeq: Math.max(current.lastSeq, message.seq),
        lastMessageAt: message.createdAt,
        // Sending counts as having read your own message (mirrors appendMessage's own
        // bookkeeping server-side), so your own outgoing messages never show up as unread here.
        lastReadSeq:
          message.senderId === auth.user?.id
            ? Math.max(current.lastReadSeq, message.seq)
            : current.lastReadSeq,
      };
      const copy = old.slice();
      copy[idx] = next;
      copy.sort(byRecency);
      return copy;
    });
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
                <li key={c.id}>
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
                </li>
              );
            })}
          </ul>
        )}
      </nav>
    </div>
  );
}
