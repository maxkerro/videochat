import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LIMITS, messageSchema, type Message, type WsEnvelope } from '@videochat/shared';
import { useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link, useParams } from 'react-router';
import { Avatar, Button } from '../../components/ui';
import { cx } from '../../lib/cx';
import { fetchConversation } from '../conversations/conversationsApi';
import { useAuth, withAuthRetry } from '../auth/AuthContext';
import { linkify } from './linkify';
import { fetchMessages, sendMessage } from './messagesApi';
import { useRealtimeEvent } from './RealtimeProvider';
import styles from './ChatPane.module.css';

interface PendingMessage {
  clientMsgId: string;
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

/** Conversation view (CHAT-014): live message history, an optimistic composer with retry, and
 *  realtime delivery of messages sent by others via CHAT-013's WebSocket gateway. */
export function ChatPane() {
  const { conversationId } = useParams();
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<PendingMessage[]>([]);

  const enabled = auth.status === 'authenticated' && Boolean(conversationId);

  const conversationQuery = useQuery({
    queryKey: ['conversation', conversationId],
    queryFn: () => withAuthRetry(auth, (token) => fetchConversation(token, conversationId!)),
    enabled,
    retry: false,
  });

  const messagesQuery = useQuery({
    queryKey: ['messages', conversationId],
    queryFn: () => withAuthRetry(auth, (token) => fetchMessages(token, conversationId!)),
    enabled,
  });

  useRealtimeEvent((envelope: WsEnvelope) => {
    if (envelope.type !== 'message.new' || !conversationId) return;
    const parsed = messageSchema.safeParse(envelope.payload);
    if (!parsed.success || parsed.data.conversationId !== conversationId) return;
    const message = parsed.data;
    queryClient.setQueryData<Message[]>(['messages', conversationId], (old = []) =>
      upsertMessage(old, message),
    );
    if (message.clientMsgId) {
      setPending((prev) => prev.filter((p) => p.clientMsgId !== message.clientMsgId));
    }
  });

  const messages = messagesQuery.data ?? [];
  const remaining = LIMITS.messageMaxLength - draft.length;

  async function trySend(clientMsgId: string, body: string) {
    if (!conversationId) return;
    try {
      const message = await withAuthRetry(auth, (token) =>
        sendMessage(token, conversationId, { clientMsgId, body }),
      );
      queryClient.setQueryData<Message[]>(['messages', conversationId], (old = []) =>
        upsertMessage(old, message),
      );
      setPending((prev) => prev.filter((p) => p.clientMsgId !== clientMsgId));
    } catch {
      setPending((prev) =>
        prev.map((p) => (p.clientMsgId === clientMsgId ? { ...p, status: 'failed' } : p)),
      );
    }
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const body = draft.trim();
    if (!body) return;
    const clientMsgId = newClientMsgId();
    setPending((prev) => [...prev, { clientMsgId, body, status: 'sending' }]);
    setDraft('');
    void trySend(clientMsgId, body);
  }

  function handleRetry(message: PendingMessage) {
    setPending((prev) =>
      prev.map((p) => (p.clientMsgId === message.clientMsgId ? { ...p, status: 'sending' } : p)),
    );
    void trySend(message.clientMsgId, message.body);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  if (conversationQuery.isError) {
    return (
      <section className={styles.missing}>
        <h1>Conversation not found</h1>
        <p>It may have been deleted, or you’re no longer a member.</p>
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

      <ol className={styles.messages} aria-label="Messages">
        {messages.map((m) => (
          <li key={m.id} className={cx(styles.message, m.senderId === auth.user?.id && styles.own)}>
            <span className={styles.bubble}>{m.body ? linkify(m.body) : null}</span>
            <time className={styles.time}>{timeFor(m.createdAt)}</time>
          </li>
        ))}
        {pending.map((p) => (
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
