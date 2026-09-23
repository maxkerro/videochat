import { useState } from 'react';
import { NavLink } from 'react-router';
import { Avatar, Input } from '../../components/ui';
import { cx } from '../../lib/cx';
import styles from './ConversationList.module.css';
import { sampleConversations } from './sampleData';

export function ConversationList() {
  const [query, setQuery] = useState('');
  const items = sampleConversations.filter((c) =>
    c.title.toLowerCase().includes(query.trim().toLowerCase()),
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
          <p className={styles.empty}>No conversations match “{query}”.</p>
        ) : (
          <ul className={styles.list}>
            {items.map((c) => (
              <li key={c.id}>
                <NavLink
                  to={`/c/${c.id}`}
                  className={({ isActive }) => cx(styles.item, isActive && styles.active)}
                >
                  <Avatar name={c.title} online={c.online} />
                  <span className={styles.text}>
                    <span className={styles.row}>
                      <span className={styles.title}>{c.title}</span>
                      <time className={styles.time}>{c.lastAt}</time>
                    </span>
                    <span className={styles.row}>
                      <span className={styles.preview}>{c.lastMessage}</span>
                      {c.unread > 0 && (
                        <span className={styles.badge} aria-label={`${c.unread} unread`}>
                          {c.unread > 99 ? '99+' : c.unread}
                        </span>
                      )}
                    </span>
                  </span>
                </NavLink>
              </li>
            ))}
          </ul>
        )}
      </nav>
    </div>
  );
}
