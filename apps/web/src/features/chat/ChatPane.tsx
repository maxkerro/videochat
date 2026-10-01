import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  conversationReadEventSchema,
  LIMITS,
  messageSchema,
  typingEventSchema,
  type ConversationSummary,
  type MembersList,
  type Message,
  type WsEnvelope,
} from '@videochat/shared';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { Avatar, Button, Menu, Modal, useToast } from '../../components/ui';
import { ApiError } from '../../lib/api';
import { cx } from '../../lib/cx';
import { recordSeenSeq } from '../../lib/lastSeenSeq';
import { useDocumentVisible } from '../../lib/useDocumentVisible';
import { enqueueOutboxMessage, removeOutboxMessage } from '../../lib/outbox';
import { blockUser, fetchBlockedUsers, unblockUser } from '../conversations/blocksApi';
import {
  fetchConversation,
  fetchMembers,
  markConversationRead,
} from '../conversations/conversationsApi';
import { GroupMembersPanel } from '../conversations/GroupMembersPanel';
import { CallButtons } from '../calls/CallButtons';
import { CallHistoryEntry } from '../calls/CallHistoryEntry';
import { useAuth, withAuthRetry } from '../auth/AuthContext';
import { linkify } from './linkify';
import { appendToLatestPage, type MessagesData } from './messagesCache';
import { fetchMessages, sendMessage } from './messagesApi';
import { ReadReceiptThrottle } from './readReceipts';
import { useRealtimeEvent, useSendTyping } from './RealtimeProvider';
import { TypingThrottle } from './typingThrottle';
import {
  formatTypingLabel,
  pruneExpiredTyping,
  withTypingEvent,
  type TypingEntry,
} from './typingIndicator';
import styles from './ChatPane.module.css';

/** How often the typing-indicator map is checked for entries that have gone stale (see
 *  `pruneExpiredTyping`) -- frequent enough that "disappears within 6s" (AC) is comfortably met,
 *  cheap enough to not matter running in the background of every open conversation. */
const TYPING_PRUNE_INTERVAL_MS = 1000;

/** CHAT-021: why a `'failed'` pending message failed, so the composer can show something more
 *  specific than a bare "Failed -- tap to retry" when the reason is known. `'rate-limited'` is
 *  the AC's own case (more than 20 messages in 10s -- see `MessageThrottlerGuard`); `'blocked'`
 *  is "a blocked user's messages to you are rejected" from the recipient's side. Both still offer
 *  retry, same as a plain failure -- this only changes the label, not the recovery path (a rate
 *  limit clears itself shortly; a block might have been lifted by the time of a retry too). */
type SendFailureReason = 'rate-limited' | 'blocked' | 'other';

interface PendingMessage {
  clientMsgId: string;
  conversationId: string;
  body: string;
  status: 'sending' | 'failed';
  failureReason?: SendFailureReason;
}

/** CHAT-021: classifies a failed send's `ApiError` status into the reasons the composer can show
 *  distinctly. `429` is `MessageThrottlerGuard`'s "slow down" response; `403` is
 *  `MessagesService.send`'s "recipient has blocked you" rejection. Anything else (validation,
 *  a 404 from being removed mid-conversation, a 500) falls back to the existing generic message. */
export function classifySendFailure(error: unknown): SendFailureReason {
  if (error instanceof ApiError) {
    if (error.status === 429) return 'rate-limited';
    if (error.status === 403) return 'blocked';
  }
  return 'other';
}

/** CHAT-021: what the composer shows for a failed pending message, given why it failed. Still
 *  ends in "tap to retry" for every case -- see `SendFailureReason`'s own comment on why retry
 *  stays available even for these two more specific reasons. */
export function failureLabelFor(reason: SendFailureReason | undefined): string {
  switch (reason) {
    case 'rate-limited':
      return "You're sending messages too fast -- wait a moment and tap to retry";
    case 'blocked':
      return "Couldn't be delivered -- tap to retry";
    default:
      return 'Failed -- tap to retry';
  }
}

/** Character counter only shows up once the person is getting close to the limit. */
const COUNTER_THRESHOLD = 200;

/** Scroll offset (px, in the flipped scroll container's own DOM coordinates -- see the `.scroll`
 *  comment below) inside which the person still counts as "at the latest message". */
const NEAR_LATEST_PX = 80;
/** How close to the far (oldest-loaded) end of the scroll container triggers loading the next
 *  page of history. */
const NEAR_OLDEST_PX = 400;
/** Consecutive messages from the same sender within this many milliseconds render as one visual
 *  group (CHAT-016: "grouped by sender and minute"), hiding the repeated timestamp. */
const GROUP_WINDOW_MS = 60_000;

function timeFor(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function dayLabelFor(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (sameDay(date, today)) return 'Today';
  if (sameDay(date, yesterday)) return 'Yesterday';
  return date.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
}

function newClientMsgId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `c-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** A 404 means "not found, or you're not a member" -- retrying won't change that. Anything else
 *  (a network blip, a 500) is worth a couple of automatic retries before giving up and showing
 *  an error, just carving out the one status that never helps. `failureCount` is 0-based (react-
 *  query's own convention: 0 on the first failure), so `< 2` caps this at 3 total attempts
 *  (~3s of exponential backoff with react-query's default retryDelay) before surfacing an error
 *  -- long enough to ride out a network blip, short enough that a real failure doesn't leave the
 *  person staring at a blank pane for too long. */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status === 404) return false;
  return failureCount < 2;
}

type Row =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'unread'; key: string }
  | { kind: 'message'; key: string; message: Message; grouped: boolean }
  | { kind: 'pending'; key: string; pending: PendingMessage };

/** Builds the flat, oldest-first list of rows to render: day separators where the calendar date
 *  changes, one "New messages" divider right before the first message past `unreadThroughSeq`
 *  (captured once when the conversation opens, so it doesn't chase the person around as they
 *  read), and a `grouped` flag on messages that follow one from the same sender within
 *  {@link GROUP_WINDOW_MS}. Exported for the same reason `shouldRetryQuery` is: easy to unit
 *  test without mounting the whole pane. */
export function buildRows(
  messages: Message[],
  pending: PendingMessage[],
  unreadThroughSeq: number | null,
): Row[] {
  const rows: Row[] = [];
  let lastDay: string | null = null;
  let unreadInserted = unreadThroughSeq === null;
  let prev: Message | null = null;

  for (const message of messages) {
    const day = new Date(message.createdAt).toDateString();
    if (day !== lastDay) {
      rows.push({ kind: 'day', key: `day-${day}`, label: dayLabelFor(message.createdAt) });
      lastDay = day;
    }
    if (!unreadInserted && unreadThroughSeq !== null && message.seq > unreadThroughSeq) {
      rows.push({ kind: 'unread', key: 'unread-divider' });
      unreadInserted = true;
    }
    const grouped = Boolean(
      prev &&
      prev.senderId === message.senderId &&
      new Date(message.createdAt).getTime() - new Date(prev.createdAt).getTime() < GROUP_WINDOW_MS,
    );
    rows.push({ kind: 'message', key: message.id, message, grouped });
    prev = message;
  }

  for (const p of pending) {
    rows.push({ kind: 'pending', key: p.clientMsgId, pending: p });
  }

  return rows;
}

/** Conversation view (CHAT-014, extended by CHAT-016): virtualized, cursor-paged message
 *  history with day separators and sender grouping, an optimistic composer with retry, and
 *  realtime delivery of messages sent by others via CHAT-013's WebSocket gateway. */
export function ChatPane() {
  const { conversationId } = useParams();
  const auth = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');
  const [membersOpen, setMembersOpen] = useState(false);
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [newArrivals, setNewArrivals] = useState(0);
  const [atLatest, setAtLatest] = useState(true);
  const [typingEntries, setTypingEntries] = useState<ReadonlyMap<string, TypingEntry>>(new Map());
  const scrollRef = useRef<HTMLDivElement>(null);
  // Captured once per conversation (see the `landedRef` reset below), so the "New messages"
  // divider and initial scroll target stay put even after later reads move `lastReadSeq` on.
  const unreadThroughRef = useRef<number | null>(null);
  const landedRef = useRef(false);

  // `ChatPane` stays mounted across a conversation switch, so an in-progress draft would
  // otherwise follow the person into the next conversation and could get sent to the wrong
  // person. Adjusted during render (React's documented pattern for this) rather than in an
  // effect, so it takes effect before the stale draft ever paints.
  const [draftConversationId, setDraftConversationId] = useState(conversationId);
  if (draftConversationId !== conversationId) {
    setDraftConversationId(conversationId);
    setDraft('');
    unreadThroughRef.current = null;
    landedRef.current = false;
    setNewArrivals(0);
    setAtLatest(true);
    setTypingEntries(new Map());
  }

  const enabled = auth.status === 'authenticated' && Boolean(conversationId);

  const conversationQuery = useQuery({
    queryKey: ['conversation', conversationId],
    queryFn: () => withAuthRetry(auth, (token) => fetchConversation(token, conversationId!)),
    enabled,
    retry: shouldRetryQuery,
  });

  // CHAT-019: a group's "Seen by N" needs every member's own `lastReadSeq`; a direct
  // conversation's simpler "Seen" already has the peer's via `conversationQuery`'s
  // `peerLastReadSeq`, so this only ever needs to run for a group.
  const membersQuery = useQuery({
    queryKey: ['members', conversationId],
    queryFn: () => withAuthRetry(auth, (token) => fetchMembers(token, conversationId!)),
    enabled: enabled && conversationQuery.data?.type === 'group',
  });

  // CHAT-021: whether the peer of *this* direct conversation is currently blocked, so the header
  // menu can offer "Block"/"Unblock" as the right toggle. Shares the `['blocked-users']` query key
  // with `ProfilePage`'s blocklist view, so blocking/unblocking from either place invalidates and
  // refreshes both without a page reload.
  const { toast } = useToast();
  const peer = conversationQuery.data?.peer;
  const blockedUsersQuery = useQuery({
    queryKey: ['blocked-users'],
    queryFn: () => withAuthRetry(auth, fetchBlockedUsers),
    enabled: enabled && conversationQuery.data?.type === 'direct',
  });
  const peerIsBlocked = Boolean(
    peer && blockedUsersQuery.data?.users.some((u) => u.id === peer.id),
  );
  const blockMutation = useMutation({
    mutationFn: (userId: string) => withAuthRetry(auth, (token) => blockUser(token, userId)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['blocked-users'] }),
    onError: () => toast({ title: "Couldn't block that person", tone: 'danger' }),
  });
  const unblockMutation = useMutation({
    mutationFn: (userId: string) => withAuthRetry(auth, (token) => unblockUser(token, userId)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['blocked-users'] }),
    onError: () => toast({ title: "Couldn't unblock that person", tone: 'danger' }),
  });

  const messagesQuery = useInfiniteQuery({
    queryKey: ['messages', conversationId],
    queryFn: ({ pageParam }) =>
      withAuthRetry(auth, (token) => fetchMessages(token, conversationId!, pageParam)),
    enabled,
    retry: shouldRetryQuery,
    initialPageParam: undefined as number | undefined,
    getNextPageParam: () => undefined,
    // The oldest-loaded page is always `pages[0]` (see the module comment on `appendToLatestPage`
    // -- previous pages are prepended, so the array stays oldest-to-newest throughout). Its own
    // oldest message's `seq` is the next `before` cursor; no more once it says so itself.
    getPreviousPageParam: (firstPage) =>
      firstPage.hasMore && firstPage.messages.length > 0 ? firstPage.messages[0]!.seq : undefined,
  });

  // Captured the first time this conversation's `lastReadSeq` is known, not kept in sync with it
  // afterwards -- otherwise reading the conversation (which advances `lastReadSeq`) would erase
  // the "New messages" divider out from under the person mid-scroll.
  if (unreadThroughRef.current === null && conversationQuery.data) {
    unreadThroughRef.current = conversationQuery.data.lastReadSeq;
  }

  useRealtimeEvent((envelope: WsEnvelope) => {
    if (envelope.type !== 'message.new') return;
    const parsed = messageSchema.safeParse(envelope.payload);
    if (!parsed.success) return;
    const message = parsed.data;
    const isOwn = message.senderId === auth.user?.id;
    // Own messages are cleared out of `pending` (and the offline outbox) regardless of which
    // conversation is currently open -- CHAT-017's outbox flush can complete a send for a
    // conversation the person has since navigated away from, and the "sending…" bubble for it
    // needs to clear the moment that happens, not only once they scroll back to it. `clientMsgId`
    // is only unique per sender (the server dedupes on (senderId, clientMsgId)), so without the
    // sender check another member's message could coincidentally share the id of one of *our*
    // pending entries and clear a bubble that hasn't actually been confirmed sent.
    if (message.clientMsgId && isOwn) {
      setPending((prev) => prev.filter((p) => p.clientMsgId !== message.clientMsgId));
      void removeOutboxMessage(message.clientMsgId);
    }
    // Likewise, the query cache is keyed by the message's own conversation, so this merges
    // correctly whether or not that conversation is the one currently rendered.
    queryClient.setQueryData<MessagesData>(['messages', message.conversationId], (old) =>
      appendToLatestPage(old, message),
    );
    recordSeenSeq(message.conversationId, message.seq);
    if (message.conversationId !== conversationId) return;
    if (!isOwn && !atLatest) setNewArrivals((n) => n + 1);
  });

  // CHAT-019: another device/tab of the same person catching up (clears this device's own
  // "unread" state), or another member's read position advancing (updates "Seen"/"Seen by N")
  // -- either way, applied straight to the cache rather than waiting on a refetch.
  useRealtimeEvent((envelope: WsEnvelope) => {
    if (envelope.type !== 'conversation.read') return;
    const parsed = conversationReadEventSchema.safeParse(envelope.payload);
    if (!parsed.success) return;
    const event = parsed.data;
    if (event.conversationId !== conversationId) return;

    if (event.userId === auth.user?.id) {
      queryClient.setQueryData<ConversationSummary>(
        ['conversation', event.conversationId],
        (old) => (old ? { ...old, lastReadSeq: event.lastReadSeq } : old),
      );
      return;
    }
    queryClient.setQueryData<ConversationSummary>(['conversation', event.conversationId], (old) =>
      old && old.peer?.id === event.userId ? { ...old, peerLastReadSeq: event.lastReadSeq } : old,
    );
    queryClient.setQueryData<MembersList>(['members', event.conversationId], (old) =>
      old?.map((m) => (m.userId === event.userId ? { ...m, lastReadSeq: event.lastReadSeq } : m)),
    );
  });

  // CHAT-020: another member's "I'm typing" signal. Own events are skipped -- the conversation
  // channel also reaches this person's *own* other open sockets (same as `conversation.read`),
  // and someone doesn't need to be told they themselves are typing. Purely client-side state:
  // nothing here is persisted (see `typingEventSchema`'s comment), and `pruneExpiredTyping` below
  // is what makes an entry disappear again if no refresh follows.
  useRealtimeEvent((envelope: WsEnvelope) => {
    if (envelope.type !== 'conversation.typing') return;
    const parsed = typingEventSchema.safeParse(envelope.payload);
    if (!parsed.success) return;
    const event = parsed.data;
    if (event.conversationId !== conversationId || event.userId === auth.user?.id) return;
    setTypingEntries((prev) => withTypingEvent(prev, event, Date.now()));
  });

  // Prunes entries that haven't been refreshed within TYPING_EXPIRY_MS, on a plain interval
  // rather than one timer per typer -- simpler, and "disappears within 6s" doesn't need
  // millisecond precision on when exactly that happens.
  useEffect(() => {
    const timer = setInterval(() => {
      setTypingEntries((prev) => pruneExpiredTyping(prev, Date.now()));
    }, TYPING_PRUNE_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  const allMessages = useMemo(
    () => messagesQuery.data?.pages.flatMap((page) => page.messages) ?? [],
    [messagesQuery.data],
  );
  // Seeds the gap-sync bookmark from ordinary history loading too, not just live events -- so a
  // conversation opened for the first time (or reopened after being closed) has a bookmark before
  // it's ever received a live message, letting the very first reconnect actually catch up.
  const latestLoadedSeq = allMessages.at(-1)?.seq;
  useEffect(() => {
    if (conversationId && latestLoadedSeq !== undefined)
      recordSeenSeq(conversationId, latestLoadedSeq);
  }, [conversationId, latestLoadedSeq]);
  const remaining = LIMITS.messageMaxLength - draft.length;
  // `ChatPane` is reused across a conversation switch (the route just changes `:conversationId`
  // on the same component instance), so `pending` can hold entries left over from a conversation
  // the person has since navigated away from -- filter to this conversation's own before
  // rendering, so a failed send from A never shows up (or gets retried into) B.
  const pendingHere = pending.filter((p) => p.conversationId === conversationId);

  // Oldest-first for building day separators and the unread divider in chronological order, then
  // reversed for rendering: the scroll container is visually flipped (`.scroll` in the CSS
  // module) so that "the latest message" always sits at `scrollTop: 0` and loading more history
  // only ever appends rows *after* whatever the person is currently looking at, never before it
  // -- the usual fix for a virtualized chat list jumping every time older messages load in.
  const rows = useMemo(
    () => buildRows(allMessages, pendingHere, unreadThroughRef.current),
    [allMessages, pendingHere],
  );
  const reversedRows = useMemo(() => [...rows].reverse(), [rows]);

  const rowVirtualizer = useVirtualizer({
    count: reversedRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 64,
    overscan: 12,
  });

  // CHAT-019: read receipts. `authRef` lets the throttle's `send` callback (built once, in the
  // `useState` lazy initializer below, and never rebuilt) always read the *current* access token
  // rather than closing over whatever it was when the throttle was created.
  const authRef = useRef(auth);
  authRef.current = auth;
  const [readReceiptThrottle] = useState(
    () =>
      new ReadReceiptThrottle((targetConversationId, seq) => {
        withAuthRetry(authRef.current, (token) =>
          markConversationRead(token, targetConversationId, { seq }),
        )
          .then((summary) => {
            queryClient.setQueryData(['conversation', targetConversationId], summary);
            queryClient.setQueryData<ConversationSummary[]>(['conversations'], (list) =>
              list?.map((c) =>
                c.id === targetConversationId ? { ...c, lastReadSeq: summary.lastReadSeq } : c,
              ),
            );
          })
          // Best-effort: a failed read receipt (offline, a transient 5xx) isn't worth surfacing
          // to the person -- the next visible message (or the next `catchUp` reconnect) will
          // simply try again with a higher `seq` anyway.
          .catch(() => undefined);
      }),
  );
  const documentVisible = useDocumentVisible();

  // CHAT-020: sends a throttled "I'm typing" signal as the person types. `sendTypingRef` mirrors
  // the `authRef` pattern just above -- the throttle instance is built once (lazy `useState`
  // initializer) and must always call the *current* `sendTyping`, not whatever it closed over.
  const sendTyping = useSendTyping();
  const sendTypingRef = useRef(sendTyping);
  sendTypingRef.current = sendTyping;
  const [typingThrottle] = useState(
    () => new TypingThrottle((targetConversationId) => sendTypingRef.current(targetConversationId)),
  );
  const typingLabel = useMemo(
    () => formatTypingLabel([...typingEntries.values()].map((e) => e.displayName)),
    [typingEntries],
  );

  // AC: "receipts are not sent while the tab is hidden" -- drops (never sends) whatever was
  // pending for this conversation the moment it goes hidden, rather than letting it fire the
  // instant the tab becomes visible again (which would defeat the point: the person didn't
  // actually look at anything while it was hidden).
  useEffect(() => {
    if (!documentVisible && conversationId) readReceiptThrottle.cancel(conversationId);
  }, [documentVisible, conversationId, readReceiptThrottle]);

  // Reports the highest-`seq` message currently in the virtualizer's visible range as read, via
  // the throttle above -- called after scrolling and whenever the rendered rows change (new
  // messages arriving, history loading in), so a message that becomes visible without a scroll
  // event (e.g. it was already the first thing on screen) still gets picked up.
  const reportVisibleRead = useCallback(() => {
    if (!documentVisible || !conversationId || auth.status !== 'authenticated') return;
    let maxSeq = 0;
    for (const item of rowVirtualizer.getVirtualItems()) {
      const row = reversedRows[item.index];
      if (row?.kind === 'message' && row.message.type !== 'system' && row.message.seq > maxSeq) {
        maxSeq = row.message.seq;
      }
    }
    if (maxSeq > 0) readReceiptThrottle.request(conversationId, maxSeq);
  }, [
    documentVisible,
    conversationId,
    auth.status,
    rowVirtualizer,
    reversedRows,
    readReceiptThrottle,
  ]);

  useEffect(() => {
    reportVisibleRead();
    // `rows.length` (rather than `rows` itself) is the trigger: a change in *count* means
    // something entered or left the rendered range (a new message, another page of history), the
    // only case that can change which messages are visible without a scroll event.
  }, [reportVisibleRead, rows.length]);

  const scrollToLatest = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const el = scrollRef.current;
    // jsdom (and some older embedded WebViews) don't implement `Element.scrollTo` -- fall back to
    // a plain assignment, which every environment that has a scrollable element supports.
    if (el) {
      if (typeof el.scrollTo === 'function') el.scrollTo({ top: 0, behavior });
      else el.scrollTop = 0;
    }
    setNewArrivals(0);
    setAtLatest(true);
  }, []);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const nearLatest = el.scrollTop <= NEAR_LATEST_PX;
    setAtLatest(nearLatest);
    if (nearLatest) setNewArrivals(0);
    const nearOldest = el.scrollHeight - el.clientHeight - el.scrollTop <= NEAR_OLDEST_PX;
    if (nearOldest && messagesQuery.hasPreviousPage && !messagesQuery.isFetchingPreviousPage) {
      void messagesQuery.fetchPreviousPage();
    }
    reportVisibleRead();
  }

  // Lands the initial view on the first unread message (or the latest message if everything is
  // already read) the first time this conversation's history finishes loading -- once only, via
  // `landedRef`, so it doesn't keep re-scrolling the person as more history or live messages
  // arrive afterwards.
  useLayoutEffect(() => {
    if (landedRef.current || messagesQuery.isPending || rows.length === 0) return;
    landedRef.current = true;
    const unreadIndex = rows.findIndex((r) => r.kind === 'unread');
    if (unreadIndex === -1) return; // Nothing unread: the default scrollTop 0 is already "latest".
    const reversedIndex = reversedRows.length - 1 - unreadIndex;
    rowVirtualizer.scrollToIndex(reversedIndex, { align: 'center' });
  }, [messagesQuery.isPending, rows, reversedRows, rowVirtualizer]);

  async function trySend(target: { clientMsgId: string; conversationId: string; body: string }) {
    try {
      const message = await withAuthRetry(auth, (token) =>
        sendMessage(token, target.conversationId, {
          clientMsgId: target.clientMsgId,
          body: target.body,
        }),
      );
      queryClient.setQueryData<MessagesData>(['messages', target.conversationId], (old) =>
        appendToLatestPage(old, message),
      );
      setPending((prev) => prev.filter((p) => p.clientMsgId !== target.clientMsgId));
      // CHAT-017: a message that made it to the server is also done as far as the outbox is
      // concerned -- most commonly because `RealtimeProvider`'s own flush just sent it, but this
      // covers the ordinary in-app send path too, in case it was queued by an earlier failed
      // attempt this session.
      void removeOutboxMessage(target.clientMsgId);
    } catch (error) {
      // CHAT-017: `ApiError` means the server was reached and said no (validation, a conflict,
      // being removed from the conversation) -- retrying that unattended would just fail again, so
      // it stays "failed" for a person to explicitly retry. Anything else (a `TypeError` from
      // `fetch` itself, offline) never reached the server at all: queue it in the outbox so
      // `RealtimeProvider` sends it automatically, in order, the moment the connection comes back,
      // rather than leaving it stranded on a "tap to retry" the person has to remember to press.
      if (!(error instanceof ApiError)) {
        void enqueueOutboxMessage({
          clientMsgId: target.clientMsgId,
          conversationId: target.conversationId,
          body: target.body,
          queuedAt: Date.now(),
        });
      }
      const failureReason = classifySendFailure(error);
      setPending((prev) =>
        prev.map((p) =>
          p.clientMsgId === target.clientMsgId ? { ...p, status: 'failed', failureReason } : p,
        ),
      );
    }
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const body = draft.trim();
    if (!body || !conversationId) return;
    const clientMsgId = newClientMsgId();
    setPending((prev) => [...prev, { clientMsgId, conversationId, body, status: 'sending' }]);
    setDraft('');
    void trySend({ clientMsgId, conversationId, body });
    scrollToLatest('auto');
  }

  function handleRetry(message: PendingMessage) {
    setPending((prev) =>
      prev.map((p) => (p.clientMsgId === message.clientMsgId ? { ...p, status: 'sending' } : p)),
    );
    void trySend(message);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  // CHAT-019: "Seen" for a direct conversation once the peer's own `lastReadSeq` catches up to
  // the latest message; "Seen by N" for a group, with the names available on hover (a native
  // `title` tooltip -- simplest thing that satisfies the AC without a new popover primitive).
  // Both are `null` (nothing rendered) for an empty conversation -- "seen" is meaningless with no
  // messages to have seen. Computed above the early `isError` return below so this hook always
  // runs in the same order regardless of query state (React's rules of hooks).
  const seenInfo = useMemo(() => {
    const conversation = conversationQuery.data;
    if (!conversation || conversation.lastSeq === 0) return null;
    if (conversation.type === 'direct') {
      const seen =
        conversation.peerLastReadSeq !== null &&
        conversation.peerLastReadSeq >= conversation.lastSeq;
      return seen ? { label: 'Seen', names: [] as string[] } : null;
    }
    const seenBy = (membersQuery.data ?? []).filter(
      (m) => m.userId !== auth.user?.id && m.lastReadSeq >= conversation.lastSeq,
    );
    if (seenBy.length === 0) return null;
    return { label: `Seen by ${seenBy.length}`, names: seenBy.map((m) => m.displayName) };
  }, [conversationQuery.data, membersQuery.data, auth.user?.id]);

  if (conversationQuery.isError) {
    // A 404 means the conversation genuinely doesn't exist (or isn't this person's) -- that's
    // the only case "not found" is an accurate message for. Anything else (a network failure, a
    // 500) gets a generic message instead, rather than telling someone their conversation is
    // gone when the server is just having a bad moment.
    const notFound =
      conversationQuery.error instanceof ApiError && conversationQuery.error.status === 404;
    return (
      <section className={styles.missing}>
        <h1>{notFound ? 'Conversation not found' : 'Something went wrong'}</h1>
        <p>
          {notFound
            ? 'It may have been deleted, or you’re no longer a member.'
            : 'Could not load this conversation.'}
        </p>
        {/* A 404 is final -- retrying won't help. Anything else already got a few automatic
         *  retries via shouldRetryQuery; this is for once those are exhausted too. */}
        {!notFound && (
          <Button type="button" onClick={() => void conversationQuery.refetch()}>
            Try again
          </Button>
        )}
        <Link to="/">Back to conversations</Link>
      </section>
    );
  }

  const conversation = conversationQuery.data;
  const title = conversation?.peer?.displayName ?? conversation?.title ?? 'Conversation';

  return (
    <section className={styles.pane} aria-label={`Conversation with ${title}`}>
      <header className={styles.header}>
        <Link to="/" className={styles.back} aria-label="Back to conversations">
          <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M15 5l-7 7 7 7"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </Link>
        <Avatar name={title} src={conversation?.peer?.avatarUrl} />
        <div className={styles.headerText}>
          <h1 className={styles.title}>{title}</h1>
          {seenInfo && (
            <span
              className={styles.seen}
              title={seenInfo.names.length > 0 ? seenInfo.names.join(', ') : undefined}
            >
              {seenInfo.label}
            </span>
          )}
        </div>
        {/* CHAT-018: group-only -- a direct conversation has no roles or membership to manage. */}
        {conversation?.type === 'group' && (
          <Button variant="ghost" size="sm" onClick={() => setMembersOpen(true)}>
            Members
          </Button>
        )}
        {/* CHAT-021: block/unblock, direct-conversation-only -- a group has no single "the other
         *  person" to act on (see `MessagesService.send`'s own comment on why block enforcement
         *  itself is scoped to DMs). */}
        {/* CHAT-042: 1:1 calls only -- calling isn't offered in groups. Disabled while you've
         *  blocked them (the server would refuse anyway). */}
        {conversation?.type === 'direct' && peer && conversationId && (
          <CallButtons peer={peer} conversationId={conversationId} disabled={peerIsBlocked} />
        )}
        {conversation?.type === 'direct' && peer && (
          <Menu
            trigger={
              <Button variant="ghost" size="icon" aria-label={`More options for ${title}`}>
                ⋮
              </Button>
            }
            items={[
              peerIsBlocked
                ? {
                    label: `Unblock ${peer.displayName}`,
                    onSelect: () => unblockMutation.mutate(peer.id),
                  }
                : {
                    label: `Block ${peer.displayName}`,
                    onSelect: () => blockMutation.mutate(peer.id),
                  },
            ]}
          />
        )}
      </header>

      {messagesQuery.isError ? (
        // Without this, a failed history load rendered an empty list -- indistinguishable from
        // "no messages yet" -- rather than telling the person their history didn't actually load.
        <div className={styles.missing} role="alert">
          <p>Could not load messages.</p>
          <Button type="button" onClick={() => void messagesQuery.refetch()}>
            Try again
          </Button>
        </div>
      ) : (
        <div className={styles.scrollWrap}>
          {/* Flipped so the newest message sits at scrollTop 0 -- see the `rows`/`reversedRows`
           *  comment above for why. A plain `role="list"` div rather than a real `<ol>`: the
           *  virtualizer needs an absolutely-positioned sizer between the scroll container and
           *  the rows, which an `<ol>` can't hold directly without breaking list semantics. */}
          <div
            ref={scrollRef}
            className={styles.scroll}
            role="list"
            aria-label="Messages"
            onScroll={handleScroll}
          >
            <div
              style={{ height: rowVirtualizer.getTotalSize(), position: 'relative', width: '100%' }}
            >
              {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                const row = reversedRows[virtualRow.index];
                if (!row) return null;
                return (
                  <div
                    key={row.key}
                    ref={rowVirtualizer.measureElement}
                    data-index={virtualRow.index}
                    role="listitem"
                    className={styles.virtualRow}
                    style={{ transform: `translateY(${virtualRow.start}px) scaleY(-1)` }}
                  >
                    {row.kind === 'day' && (
                      <div className={styles.daySeparator}>
                        <span>{row.label}</span>
                      </div>
                    )}
                    {row.kind === 'unread' && (
                      <div
                        className={styles.unreadDivider}
                        role="separator"
                        aria-label="New messages"
                      >
                        <span>New messages</span>
                      </div>
                    )}
                    {row.kind === 'message' && row.message.type === 'system' && (
                      // CHAT-018: a membership change ("Anna added Ben") -- centered, no
                      // avatar/bubble/own-vs-theirs styling, since it isn't from anyone in
                      // particular (`senderId` is null). Reuses the plain message row rather than
                      // a new `Row` kind: it needs no grouping, day-separator or unread-divider
                      // interaction beyond what a normal message already gets from `buildRows`.
                      <div className={styles.system}>{row.message.body}</div>
                    )}
                    {row.kind === 'message' && row.message.type === 'call' && (
                      // CHAT-044: a call's outcome ("Missed video call"), with "Call back".
                      <div className={styles.systemRow}>
                        <CallHistoryEntry
                          message={row.message}
                          myUserId={auth.user?.id}
                          peer={conversation?.type === 'direct' ? (peer ?? null) : null}
                          time={timeFor(row.message.createdAt)}
                        />
                      </div>
                    )}
                    {row.kind === 'message' &&
                      row.message.type !== 'system' &&
                      row.message.type !== 'call' && (
                        <div
                          className={cx(
                            styles.message,
                            row.message.senderId === auth.user?.id && styles.own,
                            row.grouped && styles.grouped,
                          )}
                        >
                          <span className={styles.bubble}>
                            {row.message.body ? linkify(row.message.body) : null}
                          </span>
                          {!row.grouped && (
                            <time className={styles.time}>{timeFor(row.message.createdAt)}</time>
                          )}
                        </div>
                      )}
                    {row.kind === 'pending' && (
                      <div className={cx(styles.message, styles.own)}>
                        <span className={styles.bubble}>{linkify(row.pending.body)}</span>
                        {row.pending.status === 'sending' ? (
                          <span className={styles.time}>Sending…</span>
                        ) : (
                          <button
                            type="button"
                            className={styles.retry}
                            onClick={() => handleRetry(row.pending)}
                          >
                            {failureLabelFor(row.pending.failureReason)}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
          {messagesQuery.isFetchingPreviousPage && (
            <div className={styles.historyLoading} role="status">
              Loading earlier messages…
            </div>
          )}
          {!atLatest && (
            <button type="button" className={styles.jumpLatest} onClick={() => scrollToLatest()}>
              {newArrivals > 0
                ? `${newArrivals} new message${newArrivals === 1 ? '' : 's'} ↓`
                : 'Jump to latest ↓'}
            </button>
          )}
        </div>
      )}

      {typingLabel && (
        <div className={styles.typingIndicator} role="status" aria-live="polite">
          {typingLabel}
        </div>
      )}

      <form className={styles.composer} onSubmit={handleSubmit}>
        <label htmlFor="composer" className="visually-hidden">
          Message
        </label>
        <textarea
          id="composer"
          className={styles.input}
          rows={1}
          placeholder="Write a message…"
          value={draft}
          maxLength={LIMITS.messageMaxLength}
          onChange={(event) => {
            const value = event.target.value;
            setDraft(value);
            // AC: "throttled to one per 3s per user" -- only while there's actually something
            // being typed; clearing the composer (or never having typed anything) sends nothing.
            if (value.trim() && conversationId) typingThrottle.notifyTyping(conversationId);
          }}
          onKeyDown={handleKeyDown}
        />
        {remaining <= COUNTER_THRESHOLD && (
          <span className={styles.counter} aria-live="polite">
            {remaining}
          </span>
        )}
        <Button type="submit" aria-label="Send message" disabled={!draft.trim()}>
          Send
        </Button>
      </form>

      {conversation?.type === 'group' && (
        <Modal open={membersOpen} onOpenChange={setMembersOpen} title="Group members" footer={null}>
          {membersOpen && (
            <GroupMembersPanel
              conversation={conversation}
              onClose={() => setMembersOpen(false)}
              onLeft={() => {
                setMembersOpen(false);
                void queryClient.invalidateQueries({ queryKey: ['conversations'] });
                navigate('/');
              }}
            />
          )}
        </Modal>
      )}
    </section>
  );
}
