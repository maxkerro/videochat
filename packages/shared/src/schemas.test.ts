import { describe, expect, it } from 'vitest';
import {
  addMembersSchema,
  blockedUsersListSchema,
  createGroupConversationSchema,
  LIMITS,
  makeEnvelope,
  memberSummarySchema,
  messagesPageQuerySchema,
  renameConversationSchema,
  callStatsSchema,
  sendMessageSchema,
  typingEventSchema,
  typingSignalSchema,
  usernameSchema,
  ulidSchema,
  wsEnvelopeSchema,
} from './index.js';

describe('usernameSchema', () => {
  it('accepts lowercase handles', () => {
    expect(usernameSchema.safeParse('anna_k').success).toBe(true);
  });

  it.each(['ab', 'Anna', 'anna-k', 'a'.repeat(31)])('rejects %s', (value) => {
    expect(usernameSchema.safeParse(value).success).toBe(false);
  });
});

describe('ulidSchema', () => {
  it('accepts a valid ULID', () => {
    expect(ulidSchema.safeParse('01J9ZQ3X4K7M8N9P0QRSTVWXYZ').success).toBe(true);
  });

  it('rejects ambiguous characters', () => {
    expect(ulidSchema.safeParse('01J9ZQ3X4K7M8N9P0QRSTVWXYI').success).toBe(false);
  });
});

describe('makeEnvelope', () => {
  it('produces an envelope that passes validation', () => {
    const env = makeEnvelope('message.new', { text: 'hi' }, 'evt_1');
    expect(wsEnvelopeSchema.parse(env)).toMatchObject({ v: 1, type: 'message.new' });
  });
});

describe('messagesPageQuerySchema (CHAT-016/CHAT-017)', () => {
  it('accepts neither, just `before`, or just `after`', () => {
    expect(messagesPageQuerySchema.safeParse({}).success).toBe(true);
    expect(messagesPageQuerySchema.safeParse({ before: 5 }).success).toBe(true);
    expect(messagesPageQuerySchema.safeParse({ after: 0 }).success).toBe(true);
    expect(messagesPageQuerySchema.safeParse({ after: 5 }).success).toBe(true);
  });

  it('rejects passing both `before` and `after`', () => {
    expect(messagesPageQuerySchema.safeParse({ before: 5, after: 1 }).success).toBe(false);
  });

  it('rejects a non-positive `before` and a negative `after`', () => {
    expect(messagesPageQuerySchema.safeParse({ before: 0 }).success).toBe(false);
    expect(messagesPageQuerySchema.safeParse({ before: -1 }).success).toBe(false);
    expect(messagesPageQuerySchema.safeParse({ after: -1 }).success).toBe(false);
  });
});

describe('createGroupConversationSchema (CHAT-018)', () => {
  // A valid-format (v4) UUID, not just a sequential-looking string -- zod's z.uuid() checks the
  // version/variant nibbles, so a fake id like "...-0000-0000-...-000000000001" fails validation
  // even though it looks unique enough for a test.
  const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

  it('accepts a title and one or more distinct member ids', () => {
    const result = createGroupConversationSchema.safeParse({
      title: 'Weekend trip',
      memberIds: [uuid(1), uuid(2)],
    });
    expect(result.success).toBe(true);
  });

  it('rejects an empty title, an empty member list, and duplicate members', () => {
    expect(
      createGroupConversationSchema.safeParse({ title: '', memberIds: [uuid(1)] }).success,
    ).toBe(false);
    expect(createGroupConversationSchema.safeParse({ title: 'x', memberIds: [] }).success).toBe(
      false,
    );
    expect(
      createGroupConversationSchema.safeParse({ title: 'x', memberIds: [uuid(1), uuid(1)] })
        .success,
    ).toBe(false);
  });

  it('rejects a title longer than the limit and a member list at/over the cap', () => {
    expect(
      createGroupConversationSchema.safeParse({
        title: 'x'.repeat(LIMITS.groupTitleMax + 1),
        memberIds: [uuid(1)],
      }).success,
    ).toBe(false);
    const tooMany = Array.from({ length: LIMITS.groupMaxMembers }, (_, i) => uuid(i));
    expect(
      createGroupConversationSchema.safeParse({ title: 'x', memberIds: tooMany }).success,
    ).toBe(false);
  });
});

describe('renameConversationSchema and addMembersSchema (CHAT-018)', () => {
  it('renameConversationSchema requires a non-empty title within the limit', () => {
    expect(renameConversationSchema.safeParse({ title: 'New name' }).success).toBe(true);
    expect(renameConversationSchema.safeParse({ title: '' }).success).toBe(false);
  });

  it('addMembersSchema requires at least one distinct member id', () => {
    const uuid = '00000000-0000-4000-8000-000000000001';
    expect(addMembersSchema.safeParse({ memberIds: [uuid] }).success).toBe(true);
    expect(addMembersSchema.safeParse({ memberIds: [] }).success).toBe(false);
    expect(addMembersSchema.safeParse({ memberIds: [uuid, uuid] }).success).toBe(false);
  });
});

describe('memberSummarySchema (CHAT-018)', () => {
  it('accepts a well-formed member row', () => {
    const result = memberSummarySchema.safeParse({
      userId: '00000000-0000-4000-8000-000000000001',
      username: 'anna',
      displayName: 'Anna',
      avatarUrl: null,
      role: 'admin',
      joinedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an invalid role', () => {
    const result = memberSummarySchema.safeParse({
      userId: '00000000-0000-4000-8000-000000000001',
      username: 'anna',
      displayName: 'Anna',
      avatarUrl: null,
      role: 'owner',
      joinedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(result.success).toBe(false);
  });
});

describe('typingSignalSchema and typingEventSchema (CHAT-020)', () => {
  const uuid = '00000000-0000-4000-8000-000000000001';

  it('typingSignalSchema accepts just a conversationId -- the client never supplies its own identity', () => {
    expect(typingSignalSchema.safeParse({ conversationId: uuid }).success).toBe(true);
    expect(typingSignalSchema.safeParse({}).success).toBe(false);
    expect(typingSignalSchema.safeParse({ conversationId: 'not-a-uuid' }).success).toBe(false);
  });

  it('typingEventSchema accepts the full server-filled shape', () => {
    const result = typingEventSchema.safeParse({
      conversationId: uuid,
      userId: uuid,
      displayName: 'Anna',
    });
    expect(result.success).toBe(true);
  });

  it('typingEventSchema rejects a missing displayName or userId', () => {
    expect(typingEventSchema.safeParse({ conversationId: uuid, userId: uuid }).success).toBe(false);
    expect(typingEventSchema.safeParse({ conversationId: uuid, displayName: 'Anna' }).success).toBe(
      false,
    );
  });

  it('round-trips through makeEnvelope/wsEnvelopeSchema like other realtime events', () => {
    const payload = { conversationId: uuid, userId: uuid, displayName: 'Anna' };
    const env = makeEnvelope('conversation.typing', payload, 'evt-typing-1');
    const parsed = wsEnvelopeSchema.parse(env);
    expect(parsed).toMatchObject({ v: 1, type: 'conversation.typing' });
    expect(typingEventSchema.parse(parsed.payload)).toEqual(payload);
  });
});

describe('blockedUsersListSchema', () => {
  const uuid = '00000000-0000-4000-8000-000000000001';

  it('accepts a list of public users', () => {
    const result = blockedUsersListSchema.safeParse({
      users: [{ id: uuid, username: 'anna_k', displayName: 'Anna', avatarUrl: null }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a row missing required PublicUser fields', () => {
    expect(blockedUsersListSchema.safeParse({ users: [{ id: uuid }] }).success).toBe(false);
  });
});

describe('sendMessageSchema', () => {
  it('accepts an ordinary client id', () => {
    expect(sendMessageSchema.safeParse({ clientMsgId: 'c-1', body: 'hi' }).success).toBe(true);
  });

  it('rejects the prefix reserved for server-originated entries', () => {
    expect(sendMessageSchema.safeParse({ clientMsgId: 'call:abc', body: 'hi' }).success).toBe(
      false,
    );
  });
});

describe('callStatsSchema', () => {
  const stats = {
    durationSec: 1,
    rttMsAvg: null,
    packetLossPctMax: null,
    outgoingKbpsMin: null,
    reconnects: 0,
    hadVideo: false,
  };

  it.each(['completed', 'answered-elsewhere', 'failed'])('accepts end cause %s', (endCause) => {
    expect(callStatsSchema.safeParse({ ...stats, endCause }).success).toBe(true);
  });

  it('rejects an end cause outside the known set', () => {
    expect(callStatsSchema.safeParse({ ...stats, endCause: 'whatever' }).success).toBe(false);
  });
});
