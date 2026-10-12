import type { Message } from '@videochat/shared';
import { describe, expect, it } from 'vitest';
import type { OutboxItem } from '../db/store';
import { buildRows } from './rows';

const ME = '3f0c9c7e-2b2c-4d5a-9f55-0d3b8f1a2b3c';
const A = '9a1c0c7e-2b2c-4d5a-9f55-0d3b8f1a2b3d';
const B = '5b0c9c7e-2b2c-4d5a-9f55-0d3b8f1a2b3e';
const now = new Date(2026, 9, 6, 12, 0);

const msg = (
  seq: number,
  senderId: string,
  day = 6,
  clientMsgId: string | null = null,
): Message => ({
  id: `01ARZ3NDEKTSV4RRFFQ69G5F${String(seq).padStart(2, '0')}`,
  conversationId: '7b0c9c7e-2b2c-4d5a-9f55-0d3b8f1a2b3f',
  seq,
  senderId,
  clientMsgId,
  type: 'text',
  body: `m${seq}`,
  replyToId: null,
  editedAt: null,
  deletedAt: null,
  createdAt: new Date(2026, 9, day, 10, seq).toISOString(),
});

const pending = (id: string): OutboxItem => ({
  clientMsgId: id,
  conversationId: 'c',
  body: id,
  replyToId: null,
  queuedAt: 0,
  state: 'queued',
  error: null,
});

const summary = (rows: ReturnType<typeof buildRows>) =>
  rows.map((r) =>
    r.kind === 'message' ? `m${r.message.seq}` : r.kind === 'day' ? `day:${r.label}` : r.key,
  );

describe('buildRows', () => {
  it('lists newest first with unsent messages at the bottom and day headings above each day', () => {
    const rows = buildRows({
      messages: [msg(1, A, 5), msg(2, ME, 6), msg(3, A, 6)],
      outbox: [pending('p1'), pending('p2')],
      myId: ME,
      isGroup: false,
      peerLastReadSeq: null,
      now,
    });
    expect(summary(rows)).toEqual([
      'pending:p2',
      'pending:p1',
      'm3',
      'm2',
      'day:Today',
      'm1',
      'day:Yesterday',
    ]);
  });

  it('shows the sender name on the first message of a run in a group, never on my own', () => {
    const rows = buildRows({
      messages: [msg(1, A), msg(2, A), msg(3, B), msg(4, ME)],
      outbox: [],
      myId: ME,
      isGroup: true,
      peerLastReadSeq: null,
      now,
    });
    const shown = rows
      .filter((r) => r.kind === 'message' && r.showSender)
      .map((r) => (r.kind === 'message' ? r.message.seq : 0));
    expect(shown.sort()).toEqual([1, 3]);
  });

  it('marks only my newest message as seen, in a direct chat, once the peer has read it', () => {
    const base = { messages: [msg(1, ME), msg(2, A), msg(3, ME)], outbox: [], myId: ME, now };
    const seen = (peerLastReadSeq: number | null, isGroup = false) =>
      buildRows({ ...base, isGroup, peerLastReadSeq })
        .filter((r) => r.kind === 'message' && r.seen)
        .map((r) => (r.kind === 'message' ? r.message.seq : 0));
    expect(seen(3)).toEqual([3]);
    expect(seen(2)).toEqual([]);
    expect(seen(null)).toEqual([]);
    expect(seen(3, true)).toEqual([]);
  });

  it('hides an outbox message once its confirmed twin is in the list', () => {
    const rows = buildRows({
      messages: [msg(1, ME, 6, 'p1')],
      outbox: [pending('p1')],
      myId: ME,
      isGroup: false,
      peerLastReadSeq: null,
      now,
    });
    expect(rows.some((r) => r.kind === 'pending')).toBe(false);
  });
});
