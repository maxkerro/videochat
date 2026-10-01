import type { MessageRow } from '../db/schema.js';
import { toMessage } from './message-mapper.js';

function makeRow(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: '01J9ZQ3X4K7M8N9P0QRSTVWXYZ',
    conversationId: 'conv-1',
    seq: 1,
    senderId: 'user-1',
    clientMsgId: 'c-1',
    type: 'text',
    body: 'hello there',
    replyToId: null,
    editedAt: null,
    deletedAt: null,
    meta: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

describe('toMessage', () => {
  it('maps a plain row through as-is', () => {
    expect(toMessage(makeRow())).toMatchObject({
      id: '01J9ZQ3X4K7M8N9P0QRSTVWXYZ',
      body: 'hello there',
      deletedAt: null,
    });
  });

  it('blanks the body of a deleted message rather than leaking it', () => {
    const message = toMessage(
      makeRow({ body: 'secret content', deletedAt: new Date('2026-01-02T00:00:00Z') }),
    );
    expect(message.body).toBeNull();
    expect(message.deletedAt).toBe('2026-01-02T00:00:00.000Z');
  });

  it('keeps the body when deletedAt is null, even if the body happens to be empty-ish', () => {
    expect(toMessage(makeRow({ body: '', deletedAt: null })).body).toBe('');
  });

  // CHAT-044
  it('includes the call summary on a call message, and only there', () => {
    const call = {
      callId: '11111111-1111-4111-8111-111111111111',
      media: 'video' as const,
      outcome: 'completed' as const,
      endReason: 'completed' as const,
      callerId: '22222222-2222-4222-8222-222222222222',
      durationSec: 754,
    };
    expect(toMessage(makeRow({ type: 'call', meta: { call } })).call).toEqual(call);
    expect('call' in toMessage(makeRow())).toBe(false);
  });
});
