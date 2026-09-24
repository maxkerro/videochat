import { useQuery } from '@tanstack/react-query';
import type { ConversationSummary } from '@videochat/shared';
import { useState } from 'react';
import { NavLink } from 'react-router';
import { Avatar, Input } from '../../components/ui';
import { useAuth, withAuthRetry } from '../auth/AuthContext';
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

export function ConversationList() {
  const auth = useAuth();
  const [query, setQuery] = useState('');

  // Real-time updates to this list (new messages bumping order, unread counts) arrive with
  // CHAT-015; for now it reflects whatever was true when the page loaded or was last focused.
  const { data: conversations = [] } = useQuery({
    queryKey: ['conversations'],
    queryFn: () => withAuthRetry(auth, fetchConversations),
    enabled: auth.status === 'authenticated',
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
