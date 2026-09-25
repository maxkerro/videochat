import {
  useInfiniteQuery,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  LIMITS,
  messageSchema,
  type Message,
  type MessagePage,
  type WsEnvelope,
} from '@videochat/shared';
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import { Link, useParams } from 'react-router';
import { Avatar, Button } from '../../components/ui';
import { ApiError } from '../../lib/api';
import { cx } from '../../lib/cx';
import { fetchConversation } from '../conversations/conversationsApi';
import { useAuth, withAuthRetry } from '../auth/AuthContext';
import { linkify } from './linkify';
import { fetchMessages, sendMessage } from './messagesApi';
import { useRealtimeEvent } from './RealtimeProvider';
import styles from './ChatPane.module.css';

interface PendingMessage {
  clientMsgId: string;
  conversationId: string;
  body: string;
  status: 'sending' | 'failed';
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

function upsertMessage(list: Message[], message: Message): Message[] {
  if (list.some((m) => m.id === message.id)) return list;
  return [...list, message].sort((a, b) => a.seq - b.seq);
}

type MessagesData = InfiniteData<MessagePage, number | undefined>;

/** Appends a live/sent message to the newest (last) loaded page -- the only page a new message
 *  can ever belong in, since pages before it are strictly older history. */
function appendToLatestPage(
  data: MessagesData | undefined,
  message: Message,
): MessagesData | undefined {
  if (!data || data.pages.length === 0) return data;
  const pages = [...data.pages];
  const lastIndex = pages.length - 1;
  pages[lastIndex] = {
    ...pages[lastIndex]!,
    messages: upsertMessage(pages[lastIndex]!.messages, message),
  };
  return { ...data, pages };
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
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<PendingMessage[]>([]);
  const [newArrivals, setNewArrivals] = useState(0);
  const [atLatest, setAtLatest] = useState(true);
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
  }

  const enabled = auth.status === 'authenticated' && Boolean(conversationId);

  const conversationQuery = useQuery({
    queryKey: ['conversation', conversationId],
    queryFn: () => withAuthRetry(auth, (token) => fetchConversation(token, conversationId!)),
    enabled,
    retry: shouldRetryQuery,
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
    if (envelope.type !== 'message.new' || !conversationId) return;
    const parsed = messageSchema.safeParse(envelope.payload);
    if (!parsed.success || parsed.data.conversationId !== conversationId) return;
    const message = parsed.data;
    queryClient.setQueryData<MessagesData>(['messages', conversationId], (old) =>
      appendToLatestPage(old, message),
    );
    const isOwn = message.senderId === auth.user?.id;
    // `clientMsgId` is only unique per sender (the server dedupes on (senderId, clientMsgId)), so
    // without the sender check another member's message could coincidentally share the id of one
    // of *our* pending entries and clear a bubble that hasn't actually been confirmed sent.
    if (message.clientMsgId && isOwn) {
      setPending((prev) => prev.filter((p) => p.clientMsgId !== message.clientMsgId));
    }
    if (!isOwn && !atLatest) setNewArrivals((n) => n + 1);
  });

  const allMessages = useMemo(
    () => messagesQuery.data?.pages.flatMap((page) => page.messages) ?? [],
    [messagesQuery.data],
  );
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
    } catch {
      setPending((prev) =>
        prev.map((p) => (p.clientMsgId === target.clientMsgId ? { ...p, status: 'failed' } : p)),
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
        </div>
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
                    {row.kind === 'message' && (
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
                            Failed -- tap to retry
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
          onChange={(event) => setDraft(event.target.value)}
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
    </section>
  );
}
