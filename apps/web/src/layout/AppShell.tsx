import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, Outlet, useMatch, useNavigate } from 'react-router';
import { Avatar, Button, Input, Modal, useToast } from '../components/ui';
import { AccountMenu } from '../features/auth/AccountMenu';
import { useAuth, withAuthRetry } from '../features/auth/AuthContext';
import { searchUsers, startDirectConversation } from '../features/conversations/conversationsApi';
import { ConversationList } from '../features/conversations/ConversationList';
import { ApiStatus } from '../features/system/ApiStatus';
import { ThemeMenu } from '../features/system/ThemeMenu';
import { useDebouncedValue } from '../lib/useDebouncedValue';
import { cx } from '../lib/cx';
import styles from './AppShell.module.css';

/** CHAT-012: search box inside the "New chat" dialog. Debounced 250ms per the story's AC. */
function NewChatDialogBody({ onStart }: { onStart: (userId: string) => void }) {
  const auth = useAuth();
  const [query, setQuery] = useState('');
  const debounced = useDebouncedValue(query.trim(), 250);

  const { data: results = { users: [] }, isFetching } = useQuery({
    queryKey: ['user-search', debounced],
    queryFn: () => withAuthRetry(auth, (token) => searchUsers(token, debounced)),
    enabled: debounced.length > 0,
  });

  return (
    <div className={styles.newChatBody}>
      <Input
        label="Username or email"
        placeholder="e.g. ben or ben@example.com"
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {debounced && !isFetching && results.users.length === 0 && (
        <p className={styles.newChatEmpty}>No one found.</p>
      )}
      {results.users.length > 0 && (
        <ul className={styles.newChatResults}>
          {results.users.map((u) => (
            <li key={u.id}>
              <button type="button" className={styles.newChatResult} onClick={() => onStart(u.id)}>
                <Avatar name={u.displayName} src={u.avatarUrl} size="sm" />
                <span>
                  <span className={styles.newChatName}>{u.displayName}</span>
                  <span className={styles.newChatUsername}>@{u.username}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Two-pane layout: conversation sidebar + chat pane.
 * Below 768px only one pane shows at a time: the list at "/", the chat at "/c/:id".
 */
export function AppShell() {
  const inConversation = useMatch('/c/:conversationId') !== null;
  const [newChatOpen, setNewChatOpen] = useState(false);
  const { toast } = useToast();
  const auth = useAuth();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  async function handleStart(userId: string) {
    try {
      const conversation = await withAuthRetry(auth, (token) =>
        startDirectConversation(token, { userId }),
      );
      setNewChatOpen(false);
      await queryClient.invalidateQueries({ queryKey: ['conversations'] });
      navigate(`/c/${conversation.id}`);
    } catch {
      toast({ title: "Couldn't start chat", description: 'Please try again.', tone: 'danger' });
    }
  }

  return (
    <div className={cx(styles.shell, inConversation && styles.showingChat)}>
      <aside className={styles.sidebar} aria-label="Sidebar">
        <header className={styles.sidebarHeader}>
          <Link to="/" className={styles.brand}>
            <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true">
              <rect width="32" height="32" rx="8" fill="var(--color-accent)" />
              <path
                d="M9 11.5A3.5 3.5 0 0 1 12.5 8h7A3.5 3.5 0 0 1 23 11.5v5a3.5 3.5 0 0 1-3.5 3.5H15l-4.2 3.4c-.6.5-1.8.1-1.8-.8Z"
                fill="var(--color-accent-text)"
              />
            </svg>
            Videochat
          </Link>
          <div className={styles.actions}>
            <ThemeMenu />
            <Button
              variant="ghost"
              size="icon"
              aria-label="New chat"
              onClick={() => setNewChatOpen(true)}
            >
              <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  d="M12 5v14M5 12h14"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </Button>
          </div>
        </header>
        <ConversationList />
        <footer className={styles.sidebarFooter}>
          <ApiStatus />
          <Link to="/ui" className={styles.footerLink}>
            UI kit
          </Link>
          <AccountMenu />
        </footer>
      </aside>

      <main className={styles.main}>
        <Outlet />
      </main>

      <Modal
        open={newChatOpen}
        onOpenChange={setNewChatOpen}
        title="New chat"
        description="Search by username or exact email. Selecting a person opens your existing DM, or starts a new one."
        footer={
          <Button variant="secondary" onClick={() => setNewChatOpen(false)}>
            Cancel
          </Button>
        }
      >
        {newChatOpen && <NewChatDialogBody onStart={handleStart} />}
      </Modal>
    </div>
  );
}
