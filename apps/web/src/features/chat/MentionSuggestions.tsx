import { activeMention, insertMention, matchMembers, type MemberSummary } from '@videochat/shared';
import { useState, type KeyboardEvent, type RefObject, type SyntheticEvent } from 'react';
import { Avatar } from '../../components/ui';
import { cx } from '../../lib/cx';
import styles from './MentionSuggestions.module.css';

const LISTBOX_ID = 'mention-options';
const optionId = (userId: string) => `mention-${userId}`;

/**
 * CHAT-073: "@" in a group's composer offers matching members; arrows move, Enter or Tab picks,
 * Escape closes. Picking replaces the typed `@que` with `@username `.
 */
export function useMentionAutocomplete({
  text,
  setText,
  members,
  myUserId,
  enabled,
  inputRef,
}: {
  text: string;
  setText: (text: string) => void;
  members: MemberSummary[];
  myUserId: string | undefined;
  enabled: boolean;
  inputRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const [caret, setCaret] = useState<number | null>(null);
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [selection, setSelection] = useState({ key: '', index: 0 });

  const active = enabled && caret !== null ? activeMention(text, caret) : null;
  const options =
    active && active.start !== dismissedAt
      ? matchMembers(members, active.query, myUserId ?? null)
      : [];
  const key = active ? `${active.start}:${active.query}` : '';
  // A new query starts at the top again.
  const index = selection.key === key ? Math.min(selection.index, options.length - 1) : 0;
  const open = options.length > 0;

  function pick(member: MemberSummary) {
    if (!active || caret === null) return;
    const next = insertMention(text, active.start, caret, member.username);
    setText(next.text);
    setCaret(next.caret);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(next.caret, next.caret);
    });
  }

  /** Call from the input's keydown first; true when the key was used here. */
  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
    if (!open) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setSelection({ key, index: (index + step + options.length) % options.length });
      return true;
    }
    if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
      event.preventDefault();
      pick(options[index]!);
      return true;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      setDismissedAt(active!.start);
      return true;
    }
    return false;
  }

  /** Call from the input's change and select events, to follow the caret. */
  function track(event: SyntheticEvent<HTMLTextAreaElement>) {
    setCaret(event.currentTarget.selectionStart);
  }

  const inputProps = open
    ? {
        'aria-autocomplete': 'list' as const,
        'aria-controls': LISTBOX_ID,
        'aria-expanded': true,
        'aria-activedescendant': optionId(options[index]!.userId),
      }
    : {};

  return { open, options, index, pick, onKeyDown, track, inputProps };
}

export function MentionSuggestions({
  options,
  index,
  onPick,
}: {
  options: MemberSummary[];
  index: number;
  onPick: (member: MemberSummary) => void;
}) {
  if (options.length === 0) return null;
  return (
    <ul id={LISTBOX_ID} role="listbox" aria-label="Mention someone" className={styles.list}>
      {options.map((m, i) => (
        <li
          key={m.userId}
          id={optionId(m.userId)}
          role="option"
          aria-selected={i === index}
          className={cx(styles.option, i === index && styles.selected)}
          // mousedown, so the composer keeps focus
          onMouseDown={(event) => {
            event.preventDefault();
            onPick(m);
          }}
        >
          <Avatar name={m.displayName} src={m.avatarUrl} size="sm" />
          <span className={styles.name}>{m.displayName}</span>
          <span className={styles.username}>@{m.username}</span>
        </li>
      ))}
    </ul>
  );
}
