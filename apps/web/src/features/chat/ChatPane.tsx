import { Link, useParams } from 'react-router';
import { Avatar, Button, Menu, useToast } from '../../components/ui';
import { cx } from '../../lib/cx';
import { sampleConversations, sampleMessages } from '../conversations/sampleData';
import styles from './ChatPane.module.css';

/** Conversation view. Layout only in M0; messages become live in CHAT-014/016. */
export function ChatPane() {
  const { conversationId } = useParams();
  const { toast } = useToast();
  const conversation = sampleConversations.find((c) => c.id === conversationId);
  const messages = (conversationId && sampleMessages[conversationId]) || [];

  if (!conversation) {
    return (
      <section className={styles.missing}>
        <h1>Conversation not found</h1>
        <p>It may have been deleted, or you’re no longer a member.</p>
        <Link to="/">Back to conversations</Link>
      </section>
    );
  }

  const notYet = () =>
    toast({ title: 'Coming in M1', description: 'Chat actions arrive with the MVP.' });

  return (
    <section className={styles.pane} aria-label={`Conversation with ${conversation.title}`}>
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
        <Avatar name={conversation.title} online={conversation.online} />
        <div className={styles.headerText}>
          <h1 className={styles.title}>{conversation.title}</h1>
          <p className={styles.subtitle}>
            {conversation.isGroup
              ? '3 members'
              : conversation.online
                ? 'Online'
                : 'Last seen recently'}
          </p>
        </div>
        <Menu
          trigger={
            <Button variant="ghost" size="icon" aria-label="Conversation options">
              <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="5" cy="12" r="2" fill="currentColor" />
                <circle cx="12" cy="12" r="2" fill="currentColor" />
                <circle cx="19" cy="12" r="2" fill="currentColor" />
              </svg>
            </Button>
          }
          items={[
            { label: 'Mute notifications', onSelect: notYet },
            { label: 'Mark as unread', onSelect: notYet },
            {
              label: conversation.isGroup ? 'Leave group' : 'Block user',
              onSelect: notYet,
              danger: true,
            },
          ]}
        />
      </header>

      <ol className={styles.messages} aria-label="Messages">
        {messages.map((m) =>
          m.system ? (
            <li key={m.id} className={styles.system}>
              {m.body}
            </li>
          ) : (
            <li key={m.id} className={cx(styles.message, m.own && styles.own)}>
              {!m.own && conversation.isGroup && <span className={styles.author}>{m.author}</span>}
              <span className={styles.bubble}>{m.body}</span>
              <time className={styles.time}>{m.at}</time>
            </li>
          ),
        )}
      </ol>

      <form
        className={styles.composer}
        onSubmit={(e) => {
          e.preventDefault();
          notYet();
        }}
      >
        <label htmlFor="composer" className="visually-hidden">
          Message
        </label>
        <textarea id="composer" className={styles.input} rows={1} placeholder="Write a message…" />
        <Button type="submit" aria-label="Send message">
          Send
        </Button>
      </form>
    </section>
  );
}
