import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LIMITS, messageSchema, type Message, type WsEnvelope } from '@videochat/shared';
import { useState, type FormEvent, type KeyboardEvent } from 'react';
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

function timeFor(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
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

/** Conversation view (CHAT-014): live message history, an optimistic composer with retry, and
 *  realtime delivery of messages sent by others via CHAT-013's WebSocket gateway. */
export function ChatPane() {
  const { conversationId } = useParams();
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<PendingMessage[]>([]);

  // `ChatPane` stays mounted across a conversation switch, so an in-progress draft would
  // otherwise follow the person into the next conversation and could get sent to the wrong
  // person. Adjusted during render (React's documented pattern for this) rather than in an
  // effect, so it takes effect before the stale draft ever paints.
  const [draftConversationId, setDraftConversationId] = useState(conversationId);
  if (draftConversationId !== conversationId) {
    setDraftConversationId(conversationId);
    setDraft('');
  }

  const enabled = auth.status === 'authenticated' && Boolean(conversationId);

  const conversationQuery = useQuery({
    queryKey: ['conversation', conversationId],
    queryFn: () => withAuthRetry(auth, (token) => fetchConversation(token, conversationId!)),
    enabled,
    retry: shouldRetryQuery,
  });

  const messagesQuery = useQuery({
    queryKey: ['messages', conversationId],
    queryFn: () => withAuthRetry(auth, (token) => fetchMessages(token, conversationId!)),
    enabled,
    retry: shouldRetryQuery,
  });

  useRealtimeEvent((envelope: WsEnvelope) => {
    if (envelope.type !== 'message.new' || !conversationId) return;
    const parsed = messageSchema.safeParse(envelope.payload);
    if (!parsed.success || parsed.data.conversationId !== conversationId) return;
    const message = parsed.data;
    queryClient.setQueryData<Message[]>(['messages', conversationId], (old = []) =>
      upsertMessage(old, message),
    );
    // `clientMsgId` is only unique per sender (the server dedupes on (senderId, clientMsgId)), so
    // without the sender check another member's message could coincidentally share the id of one
    // of *our* pending entries and clear a bubble that hasn't actually been confirmed sent.
    if (message.clientMsgId && message.senderId === auth.user?.id) {
      setPending((prev) => prev.filter((p) => p.clientMsgId !== message.clientMsgId));
    }
  });

  const messages = messagesQuery.data ?? [];
  const remaining = LIMITS.messageMaxLength - draft.length;
  // `ChatPane` is reused across a conversation switch (the route just changes `:conversationId`
  // on the same component instance), so `pending` can hold entries left over from a conversation
  // the person has since navigated away from -- filter to this conversation's own before
  // rendering, so a failed send from A never shows up (or gets retried into) B.
  const pendingHere = pending.filter((p) => p.conversationId === conversationId);

  async function trySend(target: { clientMsgId: string; conversationId: string; body: string }) {
    try {
      const message = await withAuthRetry(auth, (token) =>
        sendMessage(token, target.conversationId, {
          clientMsgId: target.clientMsgId,
          body: target.body,
        }),
      );
      queryClient.setQueryData<Message[]>(['messages', target.conversationId], (old = []) =>
        upsertMessage(old, message),
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
        // Without this, a failed history load rendered an empty <ol> -- indistinguishable from
        // "no messages yet" -- rather than telling the person their history didn't actually load.
        <div className={styles.missing} role="alert">
          <p>Could not load messages.</p>
          <Button type="button" onClick={() => void messagesQuery.refetch()}>
            Try again
          </Button>
        </div>
      ) : (
        <ol className={styles.messages} aria-label="Messages">
          {messages.map((m) => (
            <li
              key={m.id}
              className={cx(styles.message, m.senderId === auth.user?.id && styles.own)}
            >
              <span className={styles.bubble}>{m.body ? linkify(m.body) : null}</span>
              <time className={styles.time}>{timeFor(m.createdAt)}</time>
            </li>
          ))}
          {pendingHere.map((p) => (
            <li key={p.clientMsgId} className={cx(styles.message, styles.own)}>
              <span className={styles.bubble}>{linkify(p.body)}</span>
              {p.status === 'sending' ? (
                <span className={styles.time}>Sending…</span>
              ) : (
                <button type="button" className={styles.retry} onClick={() => handleRetry(p)}>
                  Failed -- tap to retry
                </button>
              )}
            </li>
          ))}
        </ol>
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
