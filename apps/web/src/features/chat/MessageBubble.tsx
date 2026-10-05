import { LIMITS, QUICK_REACTIONS, type Message, type ReplyPreview } from '@videochat/shared';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Button, Menu } from '../../components/ui';
import { cx } from '../../lib/cx';
import { AttachmentView } from '../attachments/AttachmentView';
import { LinkPreviewCard } from '../linkPreviews/LinkPreviewCard';
import { linkify } from './linkify';
import styles from './ChatPane.module.css';

const EDITABLE = new Set<Message['type']>(['text', 'image', 'file']);

/** CHAT-032: whether a message can still be edited by its sender right now. */
export function canEditMessage(message: Message, myUserId: string | undefined, now = Date.now()) {
  return (
    message.senderId === myUserId &&
    !message.deletedAt &&
    EDITABLE.has(message.type) &&
    now - Date.parse(message.createdAt) < LIMITS.messageEditWindowMinutes * 60_000
  );
}

/** CHAT-032: the sender, or a group admin, can delete a (non-call, non-system) message. */
export function canDeleteMessage(
  message: Message,
  myUserId: string | undefined,
  isGroupAdmin: boolean,
) {
  return (
    !message.deletedAt &&
    EDITABLE.has(message.type) &&
    (message.senderId === myUserId || isGroupAdmin)
  );
}

/** What a reply quote says about its original. */
export function replyQuoteText(reply: ReplyPreview): string {
  if (reply.deleted) return 'Original message deleted';
  if (reply.snippet) return reply.snippet;
  if (reply.attachment)
    return reply.attachment.kind === 'image' ? 'Photo' : reply.attachment.filename;
  return 'Message';
}

export interface MessageBubbleProps {
  message: Message;
  myUserId: string | undefined;
  grouped: boolean;
  time: string;
  isGroupAdmin: boolean;
  highlighted: boolean;
  editing: boolean;
  nameFor: (userId: string | null) => string;
  onReply: (message: Message) => void;
  onStartEdit: (message: Message) => void;
  onCancelEdit: () => void;
  onSaveEdit: (message: Message, body: string) => Promise<void>;
  onDelete: (message: Message) => void;
  onJumpTo: (reply: ReplyPreview) => void;
  onRemovePreview: (message: Message) => void;
  onToggleReaction: (message: Message, emoji: string) => void;
  onOpenPicker: (message: Message) => void;
}

/** One message in the list: reply quote, attachment, text, link preview, and its actions menu
 *  (reply / edit / delete -- CHAT-032). */
export function MessageBubble(props: MessageBubbleProps) {
  const { message, myUserId, grouped, time, editing, nameFor } = props;
  const isOwn = message.senderId === myUserId;
  const deleted = message.deletedAt !== null;
  const canEdit = canEditMessage(message, myUserId);
  const canDelete = canDeleteMessage(message, myUserId, props.isGroupAdmin);

  const actions = deleted
    ? []
    : [
        { label: 'Reply', onSelect: () => props.onReply(message) },
        { label: 'Add reaction…', onSelect: () => props.onOpenPicker(message) },
        ...(canEdit ? [{ label: 'Edit', onSelect: () => props.onStartEdit(message) }] : []),
        ...(canDelete
          ? [
              {
                label: 'Delete for everyone',
                danger: true,
                onSelect: () => props.onDelete(message),
              },
            ]
          : []),
      ];

  return (
    <div
      className={cx(
        styles.message,
        isOwn && styles.own,
        grouped && styles.grouped,
        props.highlighted && styles.highlighted,
      )}
      data-message-id={message.id}
    >
      {deleted ? (
        <span className={cx(styles.bubble, styles.deletedBubble)}>Message deleted</span>
      ) : editing ? (
        <EditForm
          initial={message.body ?? ''}
          onCancel={props.onCancelEdit}
          onSave={(body) => props.onSaveEdit(message, body)}
        />
      ) : (
        <span className={cx(styles.bubble, message.attachment && styles.attachmentBubble)}>
          {message.replyTo && (
            <button
              type="button"
              className={styles.quote}
              onClick={() => props.onJumpTo(message.replyTo!)}
              aria-label={`Replying to ${nameFor(message.replyTo.senderId)}: ${replyQuoteText(message.replyTo)}. Show original`}
            >
              <span className={styles.quoteAuthor}>{nameFor(message.replyTo.senderId)}</span>
              <span className={styles.quoteText}>{replyQuoteText(message.replyTo)}</span>
            </button>
          )}
          {message.attachment && <AttachmentView attachment={message.attachment} />}
          {message.body ? (
            <span className={message.attachment ? styles.caption : undefined}>
              {linkify(message.body)}
            </span>
          ) : null}
        </span>
      )}
      {!deleted && !editing && message.linkPreview && (
        <LinkPreviewCard
          preview={message.linkPreview}
          onRemove={isOwn ? () => props.onRemovePreview(message) : undefined}
        />
      )}
      {!deleted && message.reactions && message.reactions.length > 0 && (
        <div className={styles.reactions} role="group" aria-label="Reactions">
          {message.reactions.map((r) => {
            const mine = !!myUserId && r.userIds.includes(myUserId);
            const names = r.userIds.map((id) => nameFor(id)).join(', ');
            return (
              <button
                key={r.emoji}
                type="button"
                className={styles.reaction}
                aria-pressed={mine}
                aria-label={`${r.emoji} ${r.count}: ${names}. ${mine ? 'Remove your reaction' : 'React too'}`}
                title={names}
                onClick={() => props.onToggleReaction(message, r.emoji)}
              >
                <span aria-hidden="true">{r.emoji}</span>
                <span className={styles.reactionCount} aria-hidden="true">
                  {r.count}
                </span>
              </button>
            );
          })}
        </div>
      )}
      {(!grouped || message.editedAt || actions.length > 0) && (
        <div className={styles.meta}>
          {!grouped && <time className={styles.time}>{time}</time>}
          {message.editedAt && !deleted && <span className={styles.time}>(edited)</span>}
          {actions.length > 0 && !editing && message.type !== 'system' && (
            <Menu
              align={isOwn ? 'end' : 'start'}
              trigger={
                <button type="button" className={styles.actions} aria-label="React">
                  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                    <circle
                      cx="12"
                      cy="12"
                      r="9"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                    />
                    <path
                      d="M8.5 14.5a4.5 4.5 0 0 0 7 0"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.8"
                      strokeLinecap="round"
                    />
                    <circle cx="9" cy="10" r="1.2" fill="currentColor" />
                    <circle cx="15" cy="10" r="1.2" fill="currentColor" />
                  </svg>
                </button>
              }
              items={[
                ...QUICK_REACTIONS.map((emoji) => ({
                  label: emoji,
                  onSelect: () => props.onToggleReaction(message, emoji),
                })),
                { label: 'More reactions…', onSelect: () => props.onOpenPicker(message) },
              ]}
            />
          )}
          {actions.length > 0 && !editing && (
            <Menu
              align={isOwn ? 'end' : 'start'}
              trigger={
                <button type="button" className={styles.actions} aria-label="Message actions">
                  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                    <circle cx="5" cy="12" r="1.8" fill="currentColor" />
                    <circle cx="12" cy="12" r="1.8" fill="currentColor" />
                    <circle cx="19" cy="12" r="1.8" fill="currentColor" />
                  </svg>
                </button>
              }
              items={actions}
            />
          )}
        </div>
      )}
    </div>
  );
}

function EditForm({
  initial,
  onCancel,
  onSave,
}: {
  initial: string;
  onCancel: () => void;
  onSave: (body: string) => Promise<void>;
}) {
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  async function save() {
    const body = value.trim();
    if (!body) return;
    setSaving(true);
    try {
      await onSave(body);
    } finally {
      setSaving(false);
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel();
    } else if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void save();
    }
  }

  return (
    <div className={styles.editForm}>
      <label className="visually-hidden" htmlFor="edit-message">
        Edit message
      </label>
      <textarea
        id="edit-message"
        ref={ref}
        className={styles.input}
        value={value}
        maxLength={LIMITS.messageMaxLength}
        rows={2}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className={styles.editActions}>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" loading={saving} disabled={!value.trim()} onClick={() => void save()}>
          Save
        </Button>
      </div>
    </div>
  );
}
