import { LIMITS } from './domain.js';

/**
 * CHAT-073: @mentions. A mention is `@username` in a message's text, not inside a word or an
 * email address ("me@example.com" mentions nobody). The server resolves the names to members of
 * the group and stores their ids on the message (`mentions`); clients use the same rules to
 * highlight them and to offer names while typing.
 */
const NAME = `[A-Za-z0-9_]{${LIMITS.usernameMin},${LIMITS.usernameMax}}`;
const MENTION = new RegExp(`(^|[^\\p{L}\\p{N}_@])@(${NAME})(?![A-Za-z0-9_])`, 'gu');

/** Most distinct people one message can mention. */
export const MENTIONS_MAX = 20;

/** The usernames mentioned in `body`, lowercased, each once, in order of appearance. */
export function mentionedUsernames(body: string | null | undefined): string[] {
  if (!body) return [];
  const names = new Set<string>();
  for (const match of body.matchAll(MENTION)) {
    names.add(match[2]!.toLowerCase());
    if (names.size >= MENTIONS_MAX) break;
  }
  return [...names];
}

export interface MentionPart {
  text: string;
  /** Set on an `@username` that `isMention` accepted (lowercased username). */
  mention?: string;
}

/** Splits text into plain runs and the mentions `isMention` accepts (for highlighting). */
export function mentionParts(
  text: string,
  isMention: (username: string) => boolean,
): MentionPart[] {
  const parts: MentionPart[] = [];
  let last = 0;
  for (const match of text.matchAll(MENTION)) {
    const username = match[2]!.toLowerCase();
    if (!isMention(username)) continue;
    const start = match.index + match[1]!.length;
    if (start > last) parts.push({ text: text.slice(last, start) });
    const end = start + 1 + match[2]!.length;
    parts.push({ text: text.slice(start, end), mention: username });
    last = end;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

/** While typing: the `@name` being written right before the caret, if any (`query` may be ''
 *  just after typing "@"). `start` is the index of the "@". */
export function activeMention(
  text: string,
  caret: number,
): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const match = /(^|[^\p{L}\p{N}_@])@([A-Za-z0-9_]*)$/u.exec(before);
  if (!match || match[2]!.length > LIMITS.usernameMax) return null;
  return { start: caret - match[2]!.length - 1, query: match[2]!.toLowerCase() };
}

/** Replaces the `@query` being typed with `@username ` and returns the new text and caret. */
export function insertMention(
  text: string,
  start: number,
  caret: number,
  username: string,
): { text: string; caret: number } {
  const inserted = `@${username} `;
  const rest = text.slice(caret).replace(/^[A-Za-z0-9_]*\s?/, '');
  return { text: text.slice(0, start) + inserted + rest, caret: start + inserted.length };
}

/** Members whose username or display name starts with (or has a word starting with) `query`,
 *  best matches first, at most `limit`. */
export function matchMembers<M extends { userId: string; username: string; displayName: string }>(
  members: M[],
  query: string,
  excludeUserId: string | null,
  limit = 6,
): M[] {
  const q = query.toLowerCase();
  const scored: { m: M; score: number }[] = [];
  for (const m of members) {
    if (m.userId === excludeUserId) continue;
    const username = m.username.toLowerCase();
    const display = m.displayName.toLowerCase();
    const score = username.startsWith(q)
      ? 0
      : display.startsWith(q)
        ? 1
        : display.split(/\s+/).some((w) => w.startsWith(q))
          ? 2
          : -1;
    if (score >= 0) scored.push({ m, score });
  }
  return scored
    .sort((a, b) => a.score - b.score || a.m.displayName.localeCompare(b.m.displayName))
    .slice(0, limit)
    .map((s) => s.m);
}
