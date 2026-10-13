import type { Message } from '@videochat/shared';
import type { OutboxItem } from '../db/store';
import type { UploadEntry } from '../uploads/manager';
import { formatDayHeading, isSameDay } from '../ui/format';

export type ChatRow =
  | {
      kind: 'message';
      key: string;
      message: Message;
      mine: boolean;
      /** Group chats: show the sender's name above the first of their run of messages. */
      showSender: boolean;
      /** Direct chats: the peer has read up to (at least) this, my newest message. */
      seen: boolean;
    }
  | { kind: 'pending'; key: string; item: OutboxItem }
  | { kind: 'upload'; key: string; entry: UploadEntry }
  | { kind: 'day'; key: string; label: string };

/**
 * The list the conversation screen renders, newest first (the list is inverted, so index 0 sits at
 * the bottom): unsent messages at the very bottom, then the loaded history, with a day heading
 * above the first message of each day.
 */
export function buildRows(input: {
  messages: Message[];
  outbox: OutboxItem[];
  /** Files on their way (CHAT-056), oldest first. */
  uploads?: UploadEntry[];
  myId: string;
  isGroup: boolean;
  peerLastReadSeq: number | null;
  now?: Date;
}): ChatRow[] {
  const { messages, outbox, myId, isGroup, peerLastReadSeq } = input;
  const now = input.now ?? new Date();
  const rows: ChatRow[] = [];

  for (const entry of [...(input.uploads ?? [])].reverse()) {
    rows.push({ kind: 'upload', key: `upload:${entry.id}`, entry });
  }
  for (const item of [...outbox].reverse()) {
    rows.push({ kind: 'pending', key: `pending:${item.clientMsgId}`, item });
  }

  // Messages already confirmed by the server shadow their outbox twin for the instant between the
  // server answering and the outbox row being deleted.
  const sentIds = new Set(messages.map((m) => m.clientMsgId).filter(Boolean));
  const newestFirst = [...messages].reverse();
  const newestMineSeq = newestFirst.find((m) => m.senderId === myId)?.seq;

  newestFirst.forEach((message, i) => {
    const older = newestFirst[i + 1];
    const mine = message.senderId === myId;
    rows.push({
      kind: 'message',
      key: message.id,
      message,
      mine,
      showSender:
        isGroup && !mine && message.type !== 'system' && older?.senderId !== message.senderId,
      seen:
        !isGroup &&
        mine &&
        message.seq === newestMineSeq &&
        peerLastReadSeq !== null &&
        peerLastReadSeq >= message.seq,
    });
    if (!older || !isSameDay(older.createdAt, message.createdAt)) {
      rows.push({
        kind: 'day',
        key: `day:${message.id}`,
        label: formatDayHeading(message.createdAt, now),
      });
    }
  });

  return rows.filter((r) => r.kind !== 'pending' || !sentIds.has(r.item.clientMsgId));
}
