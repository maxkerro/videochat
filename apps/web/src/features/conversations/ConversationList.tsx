import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  conversationReadEventSchema,
  messageSchema,
  type ConversationSummary,
  type Message,
  type WsEnvelope,
} from '@videochat/shared';
import { useMemo, useState } from 'react';
import { NavLink } from 'react-router';
import { Avatar, Input, Menu } from '../../components/ui';
import { useAuth, withAuthRetry } from '../auth/AuthContext';
import { useRealtimeEvent } from '../chat/RealtimeProvider';
import { usePresence } from '../presence/presence';
import { useUnreadBadge } from '../notifications/unreadBadge';
import { useDrafts } from '../../lib/drafts';
import { cx } from '../../lib/cx';
import {
  fetchConversations,
  markConversationUnread,
  setConversationMuted,
} from './conversationsApi';
import styles from './ConversationList.module.css';
import { callHistoryText, isMissedByMe } from '../calls/callHistory';

function titleFor(conversation: ConversationSummary): string {
  return conversation.peer?.displayName ?? conversation.title ?? 'Conversation';
}

/** CHAT-044 (and CHAT-015's "last message preview"): the inbox's second line. */
export function previewFor(
  conversation: ConversationSummary,
  myUserId: string | undefined,
  draft?: string,
): string {
  // CHAT-036: an unsent draft takes the preview line.
  if (draft?.trim()) return `Draft: ${draft.trim().replace(/\s+/g, ' ')}`;
  const last = conversation.lastMessage;
  if (!last) return '';
  if (last.call) return callHistoryText(last.call, myUserId);
  if (last.attachment) {
    // CHAT-030: "Photo" / the file's name, with the caption if there is one.
    const what = last.attachment.kind === 'image' ? 'Photo' : last.attachment.filename;
    const text = last.body ? `${what} · ${last.body}` : what;
    return last.senderId === myUserId ? `You: ${text}` : text;
  }
  if (last.body === null) return 'Message deleted';
  if (last.type === 'system') return last.body;
  return last.senderId === myUserId ? `You: ${last.body}` : last.body;
}

/** The inbox preview fields of a message (CHAT-044/030). */
function toPreview(message: Message): NonNullable<ConversationSummary['lastMessage']> {
  return {
    type: message.type,
    senderId: message.senderId,
    body: message.body,
    ...(message.call ? { call: message.call } : {}),
    ...(message.attachment
      ? { attachment: { kind: message.attachment.kind, filename: message.attachment.filename } }
      : {}),
  };
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

  // CHAT-034: online dots for direct conversations' peers.
  const peerIds = useMemo(
    () => conversations.flatMap((c) => (c.type === 'direct' && c.peer ? [c.peer.id] : [])),
    [conversations],
  );
  const presence = usePresence(peerIds);
  // CHAT-035: unread count in the tab title and on the favicon.
  useUnreadBadge(conversations);
  const drafts = useDrafts(auth.user?.id);

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
        // CHAT-044: keep the preview line in step with the newest message.
        lastMessage: toPreview(message),
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

  // CHAT-032: an edit or delete of the newest message changes its preview line.
  useRealtimeEvent((envelope: WsEnvelope) => {
    if (envelope.type !== 'message.updated') return;
    const parsed = messageSchema.safeParse(envelope.payload);
    if (!parsed.success) return;
    const message = parsed.data;
    queryClient.setQueryData<ConversationSummary[]>(['conversations'], (list) => {
      if (!list) return list;
      const i = list.findIndex((c) => c.id === message.conversationId);
      if (i < 0 || list[i]!.lastSeq !== message.seq) return list;
      const copy = list.slice();
      copy[i] = { ...list[i]!, lastMessage: toPreview(message) };
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
  // CHAT-035: per-conversation mute.
  const muteMutation = useMutation({
    mutationFn: ({ id, muted }: { id: string; muted: boolean }) =>
      withAuthRetry(auth, (token) => setConversationMuted(token, id, muted)),
    onSuccess: (summary) =>
      queryClient.setQueryData<ConversationSummary[]>(['conversations'], (list) =>
        list?.map((c) => (c.id === summary.id ? { ...c, muted: summary.muted } : c)),
      ),
  });

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
                    <Avatar
                      name={titleFor(c)}
                      src={c.peer?.avatarUrl}
                      online={c.peer ? presence.get(c.peer.id)?.online : false}
                    />
                    <span className={styles.text}>
                      <span className={styles.row}>
                        <span className={styles.title}>
                          {titleFor(c)}
                          {c.muted && (
                            <svg
                              className={styles.mutedIcon}
                              width="12"
                              height="12"
                              viewBox="0 0 24 24"
                              role="img"
                              aria-label="Muted"
                            >
                              <path
                                d="M6 8a6 6 0 0 1 9.3-5M18 8c0 7 3 9 3 9H9M13.7 21a2 2 0 0 1-3.4 0M3 3l18 18"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                              />
                            </svg>
                          )}
                        </span>
                        <time className={styles.time}>{timeFor(c)}</time>
                      </span>
                      {(unread > 0 || c.lastMessage || drafts[c.id]) && (
                        <span className={styles.row}>
                          <span
                            className={cx(
                              styles.preview,
                              !drafts[c.id] &&
                                c.lastMessage?.call &&
                                isMissedByMe(c.lastMessage.call, auth.user?.id) &&
                                styles.previewMissed,
                              drafts[c.id] && styles.previewDraft,
                            )}
                          >
                            {previewFor(c, auth.user?.id, drafts[c.id])}
                          </span>
                          {unread > 0 && (
                            <span className={styles.badge} aria-label={`${unread} unread`}>
                              {unread > 99 ? '99+' : unread}
                            </span>
                          )}
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
                      {
                        label: c.muted ? 'Unmute notifications' : 'Mute notifications',
                        onSelect: () => muteMutation.mutate({ id: c.id, muted: !c.muted }),
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
