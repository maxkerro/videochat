import { useState } from 'react';
import { Link, Outlet, useMatch } from 'react-router';
import { Button, Input, Modal, useToast } from '../components/ui';
import { ConversationList } from '../features/conversations/ConversationList';
import { ApiStatus } from '../features/system/ApiStatus';
import { ThemeMenu } from '../features/system/ThemeMenu';
import { cx } from '../lib/cx';
import styles from './AppShell.module.css';

/**
 * Two-pane layout: conversation sidebar + chat pane.
 * Below 768px only one pane shows at a time: the list at "/", the chat at "/c/:id".
 */
export function AppShell() {
  const inConversation = useMatch('/c/:conversationId') !== null;
  const [newChatOpen, setNewChatOpen] = useState(false);
  const { toast } = useToast();

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
        </footer>
      </aside>

      <main className={styles.main}>
        <Outlet />
      </main>

      <Modal
        open={newChatOpen}
        onOpenChange={setNewChatOpen}
        title="New chat"
        description="Search by username or email. Starting chats arrives in CHAT-012."
        footer={
          <>
            <Button variant="secondary" onClick={() => setNewChatOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                setNewChatOpen(false);
                toast({
                  title: 'Coming in M1',
                  description: 'Finding people arrives with CHAT-012.',
                });
              }}
            >
              Start chat
            </Button>
          </>
        }
      >
        <Input label="Username or email" placeholder="e.g. ben or ben@example.com" autoFocus />
      </Modal>
    </div>
  );
}
