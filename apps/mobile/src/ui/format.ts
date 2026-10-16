import { attachmentLabel, LIMITS, type ConversationSummary, type Message } from '@videochat/shared';

/** CHAT-076 (spike): what the app shows for an end-to-end encrypted message (the phone apps
 *  can't decrypt yet; only browsers with the prototype on can). */
export const ENCRYPTED_MESSAGE = '🔒 Encrypted message';

const pad = (n: number) => String(n).padStart(2, '0');
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function conversationTitle(c: Pick<ConversationSummary, 'type' | 'title' | 'peer'>): string {
  if (c.type === 'group') return c.title ?? 'Group';
  return c.peer?.displayName ?? 'Chat';
}

export function unreadCount(c: Pick<ConversationSummary, 'lastSeq' | 'lastReadSeq'>): number {
  return Math.max(0, c.lastSeq - c.lastReadSeq);
}

/** The inbox's one-line preview of the newest message. */
export function lastMessagePreview(c: ConversationSummary, myId: string): string {
  const m = c.lastMessage;
  if (!m) return 'No messages yet';
  let text: string;
  if (m.type === 'call') text = 'Call';
  // "Photo", "Voice message (0:12)" (CHAT-074) or the file's name.
  else if (m.attachment) text = attachmentLabel(m.attachment);
  // CHAT-076 (spike): encrypted messages can only be read in a browser with the prototype on.
  else if (m.encrypted) text = ENCRYPTED_MESSAGE;
  else if (m.body === null) text = 'Message deleted';
  else text = m.body.replace(/\s+/g, ' ');
  return m.senderId === myId ? `You: ${text}` : text;
}

/** "14:05" today, a weekday within the last week, otherwise "3.10." style day and month. */
export function formatListTime(iso: string | null, now: Date = new Date()): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  if (d.getTime() >= startOfToday) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.getTime() >= startOfToday - 6 * dayMs) return WEEKDAYS[d.getDay()]!;
  return `${d.getDate()}.${d.getMonth() + 1}.`;
}

export function formatClock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A day heading for the message list: "Today", "Yesterday" or "3.10.2026". */
export function formatDayHeading(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(now) - startOf(d)) / (24 * 60 * 60 * 1000));
  if (diffDays === 0) return 'Today';
  if (diffDays === 1) return 'Yesterday';
  return `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`;
}

export function isSameDay(a: string, b: string): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return (
    x.getFullYear() === y.getFullYear() &&
    x.getMonth() === y.getMonth() &&
    x.getDate() === y.getDate()
  );
}

/** Own, undeleted text message still inside the edit window (the server checks again). */
export function canEditMessage(m: Message, myId: string, now: number = Date.now()): boolean {
  if (m.senderId !== myId || m.type !== 'text' || m.deletedAt || m.e2ee) return false;
  return now - new Date(m.createdAt).getTime() < LIMITS.messageEditWindowMinutes * 60_000;
}

export function canDeleteMessage(m: Message, myId: string): boolean {
  return m.senderId === myId && m.type !== 'call' && m.type !== 'system' && !m.deletedAt;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  const mb = bytes / (1024 * 1024);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** Words a call message from this viewer's side ("Missed video call", "No answer" ...). */
export function callLabel(m: Message, myId: string): string {
  const call = m.call;
  if (!call) return 'Call';
  const kind = call.media === 'video' ? 'video call' : 'voice call';
  const mine = call.callerId === myId;
  if (call.outcome === 'completed') {
    const secs = call.durationSec ?? 0;
    const dur = secs >= 60 ? `${Math.floor(secs / 60)} min ${secs % 60} s` : `${secs} s`;
    return `${mine ? 'Outgoing' : 'Incoming'} ${kind} · ${dur}`;
  }
  if (call.outcome === 'declined') return mine ? `${capital(kind)} declined` : `Declined ${kind}`;
  return mine ? 'No answer' : `Missed ${kind}`;
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
