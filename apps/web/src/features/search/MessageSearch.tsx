import { useInfiniteQuery } from '@tanstack/react-query';
import {
  snippetParts,
  type ConversationSummary,
  type SearchHas,
  type SearchResult,
} from '@videochat/shared';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { Button } from '../../components/ui';
import { useAuth, withAuthRetry } from '../auth/AuthContext';
import { afterFor, searchMessages, type SearchWhen } from './searchApi';
import styles from './MessageSearch.module.css';

/** Waits for typing to pause before searching. */
function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

export const MIN_SEARCH_LENGTH = 2;

function Snippet({ text }: { text: string }) {
  return (
    <span className={styles.snippet}>
      {snippetParts(text).map((part, i) =>
        part.match ? <mark key={i}>{part.text}</mark> : <Fragment key={i}>{part.text}</Fragment>,
      )}
    </span>
  );
}

function titleOf(c: ConversationSummary | undefined): string {
  return c?.peer?.displayName ?? c?.title ?? 'Conversation';
}

function when(iso: string): string {
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/**
 * CHAT-072: message and file search, under the conversation filter in the sidebar. Filters by
 * conversation, person, date and attachments; a result opens its chat at that message.
 */
export function MessageSearch({
  query,
  conversations,
}: {
  query: string;
  conversations: ConversationSummary[];
}) {
  const auth = useAuth();
  const navigate = useNavigate();
  const [inConversation, setInConversation] = useState('');
  const [from, setFrom] = useState('');
  const [period, setPeriod] = useState<SearchWhen>('any');
  const [has, setHas] = useState<'' | SearchHas>('');
  const q = useDebounced(query.trim(), 300);

  const byId = useMemo(() => new Map(conversations.map((c) => [c.id, c])), [conversations]);
  // People to filter by: you, and everyone you have a direct chat with.
  const people = useMemo(() => {
    const list = conversations.flatMap((c) =>
      c.type === 'direct' && c.peer ? [{ id: c.peer.id, name: c.peer.displayName }] : [],
    );
    if (auth.user) list.unshift({ id: auth.user.id, name: 'You' });
    return list;
  }, [conversations, auth.user]);

  const enabled = q.length >= MIN_SEARCH_LENGTH && auth.status === 'authenticated';
  const results = useInfiniteQuery({
    queryKey: ['search', q, inConversation, from, period, has],
    queryFn: ({ pageParam }) =>
      withAuthRetry(auth, (token) =>
        searchMessages(token, {
          q,
          conversationId: inConversation || undefined,
          from: from || undefined,
          after: afterFor(period),
          has: has || undefined,
          cursor: pageParam,
        }),
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled,
    staleTime: 10_000,
  });
  const found: SearchResult[] = results.data?.pages.flatMap((p) => p.results) ?? [];

  if (query.trim().length < MIN_SEARCH_LENGTH) return null;

  return (
    <section className={styles.wrap} aria-label="Message search">
      <h2 className={styles.heading}>Messages</h2>
      <div className={styles.filters}>
        <label>
          <span className={styles.visuallyHidden}>In</span>
          <select value={inConversation} onChange={(e) => setInConversation(e.target.value)}>
            <option value="">All chats</option>
            {conversations.map((c) => (
              <option key={c.id} value={c.id}>
                {titleOf(c)}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className={styles.visuallyHidden}>From</span>
          <select value={from} onChange={(e) => setFrom(e.target.value)}>
            <option value="">Anyone</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className={styles.visuallyHidden}>Date</span>
          <select value={period} onChange={(e) => setPeriod(e.target.value as SearchWhen)}>
            <option value="any">Any time</option>
            <option value="week">Past week</option>
            <option value="month">Past month</option>
            <option value="year">Past year</option>
          </select>
        </label>
        <label>
          <span className={styles.visuallyHidden}>Has</span>
          <select value={has} onChange={(e) => setHas(e.target.value as '' | SearchHas)}>
            <option value="">Any message</option>
            <option value="file">Has a file</option>
            <option value="image">Has a photo</option>
          </select>
        </label>
      </div>
      {results.isError ? (
        <p className={styles.status} role="alert">
          Search isn’t working right now. Please try again.
        </p>
      ) : q !== query.trim() || (results.isPending && enabled) ? (
        <p className={styles.status}>Searching…</p>
      ) : found.length === 0 ? (
        <p className={styles.status}>No messages match “{q}”.</p>
      ) : (
        <ul className={styles.results}>
          {found.map(({ message, senderName, snippet }) => (
            <li key={message.id}>
              <button
                type="button"
                className={styles.result}
                onClick={() => navigate(`/c/${message.conversationId}?msg=${message.id}`)}
              >
                <span className={styles.resultTop}>
                  <span className={styles.where}>
                    {titleOf(byId.get(message.conversationId))}
                    {senderName && byId.get(message.conversationId)?.type === 'group'
                      ? ` · ${senderName}`
                      : ''}
                  </span>
                  <time dateTime={message.createdAt}>{when(message.createdAt)}</time>
                </span>
                {message.attachment ? (
                  <span className={styles.file}>📎 {message.attachment.filename}</span>
                ) : null}
                <Snippet text={snippet} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {results.hasNextPage && (
        <Button
          variant="ghost"
          size="sm"
          disabled={results.isFetchingNextPage}
          onClick={() => void results.fetchNextPage()}
        >
          {results.isFetchingNextPage ? 'Loading…' : 'More results'}
        </Button>
      )}
    </section>
  );
}
