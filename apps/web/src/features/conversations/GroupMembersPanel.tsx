import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ConversationSummary, MembersList } from '@videochat/shared';
import { useState } from 'react';
import { Avatar, Button, Input, useToast } from '../../components/ui';
import { useAuth, withAuthRetry } from '../auth/AuthContext';
import { useDebouncedValue } from '../../lib/useDebouncedValue';
import {
  addMembers,
  fetchMembers,
  leaveConversation,
  removeMember,
  renameConversation,
  searchUsers,
} from './conversationsApi';
import styles from './GroupMembersPanel.module.css';

export interface GroupMembersPanelProps {
  conversation: ConversationSummary;
  onLeft: () => void;
  onClose: () => void;
}

/**
 * CHAT-018: the group's "members list shows roles" AC, plus admin-only rename/add/remove and a
 * leave action available to everyone. Lives in its own component (rather than folded into
 * `ChatPane`) since it has its own data (the members list) and its own set of mutations, and
 * `ChatPane` only ever needs to open it, not know how it works.
 */
export function GroupMembersPanel({ conversation, onLeft, onClose }: GroupMembersPanelProps) {
  const auth = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const isAdmin = conversation.role === 'admin';

  const [title, setTitle] = useState(conversation.title ?? '');
  const [renaming, setRenaming] = useState(false);
  const [addQuery, setAddQuery] = useState('');
  const [adding, setAdding] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [leaving, setLeaving] = useState(false);
  const debouncedAddQuery = useDebouncedValue(addQuery.trim(), 250);

  const membersQuery = useQuery({
    queryKey: ['members', conversation.id],
    queryFn: () => withAuthRetry(auth, (token) => fetchMembers(token, conversation.id)),
  });

  const { data: searchResults = { users: [] } } = useQuery({
    queryKey: ['user-search', debouncedAddQuery],
    queryFn: () => withAuthRetry(auth, (token) => searchUsers(token, debouncedAddQuery)),
    enabled: isAdmin && debouncedAddQuery.length > 0,
  });

  async function invalidate() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['members', conversation.id] }),
      queryClient.invalidateQueries({ queryKey: ['conversation', conversation.id] }),
      queryClient.invalidateQueries({ queryKey: ['conversations'] }),
      queryClient.invalidateQueries({ queryKey: ['messages', conversation.id] }),
    ]);
  }

  async function handleRename() {
    const trimmed = title.trim();
    if (!trimmed || trimmed === conversation.title) return;
    setRenaming(true);
    try {
      await withAuthRetry(auth, (token) =>
        renameConversation(token, conversation.id, { title: trimmed }),
      );
      await invalidate();
      toast({ title: 'Group renamed', tone: 'success' });
    } catch {
      toast({ title: "Couldn't rename the group", tone: 'danger' });
    } finally {
      setRenaming(false);
    }
  }

  async function handleAdd(userId: string) {
    setAdding(userId);
    try {
      await withAuthRetry(auth, (token) =>
        addMembers(token, conversation.id, { memberIds: [userId] }),
      );
      setAddQuery('');
      await invalidate();
    } catch {
      toast({ title: "Couldn't add that person", tone: 'danger' });
    } finally {
      setAdding(null);
    }
  }

  async function handleRemove(userId: string) {
    setRemoving(userId);
    try {
      await withAuthRetry(auth, (token) => removeMember(token, conversation.id, userId));
      await invalidate();
    } catch {
      toast({ title: "Couldn't remove that member", tone: 'danger' });
    } finally {
      setRemoving(null);
    }
  }

  async function handleLeave() {
    setLeaving(true);
    try {
      await withAuthRetry(auth, (token) => leaveConversation(token, conversation.id));
      onLeft();
    } catch {
      toast({ title: "Couldn't leave the group", tone: 'danger' });
      setLeaving(false);
    }
  }

  const members: MembersList = membersQuery.data ?? [];
  const alreadyMemberIds = new Set(members.map((m) => m.userId));

  return (
    <div className={styles.panel}>
      {isAdmin && (
        <div className={styles.section}>
          <Input
            label="Group name"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={80}
          />
          <Button
            size="sm"
            variant="secondary"
            onClick={() => void handleRename()}
            loading={renaming}
            disabled={!title.trim() || title.trim() === conversation.title}
          >
            Save name
          </Button>
        </div>
      )}

      <div className={styles.section}>
        <h3 className={styles.heading}>Members</h3>
        {membersQuery.isPending ? (
          <p className={styles.muted}>Loading members…</p>
        ) : (
          <ul className={styles.memberList}>
            {members.map((m) => (
              <li key={m.userId} className={styles.memberRow}>
                <Avatar name={m.displayName} src={m.avatarUrl} size="sm" />
                <span className={styles.memberText}>
                  <span className={styles.memberName}>{m.displayName}</span>
                  <span className={styles.memberUsername}>@{m.username}</span>
                </span>
                <span className={styles.role}>{m.role}</span>
                {isAdmin && m.userId !== auth.user?.id && (
                  <Button
                    size="sm"
                    variant="ghost"
                    aria-label={`Remove ${m.displayName}`}
                    onClick={() => void handleRemove(m.userId)}
                    loading={removing === m.userId}
                  >
                    Remove
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      {isAdmin && (
        <div className={styles.section}>
          <Input
            label="Add a member"
            placeholder="Search by username or email"
            value={addQuery}
            onChange={(e) => setAddQuery(e.target.value)}
          />
          {searchResults.users.length > 0 && (
            <ul className={styles.memberList}>
              {searchResults.users
                .filter((u) => !alreadyMemberIds.has(u.id))
                .map((u) => (
                  <li key={u.id} className={styles.memberRow}>
                    <Avatar name={u.displayName} src={u.avatarUrl} size="sm" />
                    <span className={styles.memberText}>
                      <span className={styles.memberName}>{u.displayName}</span>
                      <span className={styles.memberUsername}>@{u.username}</span>
                    </span>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => void handleAdd(u.id)}
                      loading={adding === u.id}
                    >
                      Add
                    </Button>
                  </li>
                ))}
            </ul>
          )}
        </div>
      )}

      <div className={styles.section}>
        <Button variant="danger" size="sm" onClick={() => void handleLeave()} loading={leaving}>
          Leave group
        </Button>
      </div>

      <Button variant="secondary" size="sm" onClick={onClose}>
        Close
      </Button>
    </div>
  );
}
