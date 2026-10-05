import type { Database } from '../db/client.js';
import { isConversationMember, markConversationRead } from '../db/conversations.js';
import { appendMessageWithStatus, SenderNotAMemberError } from '../db/messages.js';
import type { CallRow, MessageRow } from '../db/schema.js';
import type { RealtimeService } from '../realtime/realtime.service.js';
import type { NotificationsService } from '../notifications/notifications.service.js';
import type { CallSignalingService } from './call-signaling.service.js';
import {
  CallHistoryService,
  callOutcome,
  callSummaryText,
  formatCallDuration,
} from './call-history.service.js';

vi.mock('../db/messages.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db/messages.js')>()),
  appendMessageWithStatus: vi.fn(),
}));
vi.mock('../db/users.js', () => ({
  findUserById: vi.fn(async () => ({ readReceipts: true })),
  listReadReceiptMemberIds: vi.fn(async () => ['caller', 'callee']),
}));
vi.mock('../db/conversations.js', () => ({
  isConversationMember: vi.fn(),
  markConversationRead: vi.fn(),
}));

function call(overrides: Partial<CallRow>): CallRow {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    conversationId: 'conv',
    callerId: 'caller',
    calleeId: 'callee',
    media: 'video',
    status: 'ended',
    endReason: 'completed',
    callerConnectionId: 'x',
    calleeConnectionId: null,
    callerDisconnectedAt: null,
    calleeDisconnectedAt: null,
    silenced: false,
    createdAt: new Date(),
    answeredAt: new Date(),
    endedAt: new Date(),
    ...overrides,
  };
}

describe('call history wording (CHAT-044)', () => {
  it('treats every never-answered ending as missed', () => {
    for (const endReason of ['missed', 'cancelled', 'busy'] as const) {
      expect(callOutcome(call({ endReason, answeredAt: null }))).toBe('missed');
    }
  });

  it('treats an answered call that dropped as completed, but an unanswered drop as missed', () => {
    expect(callOutcome(call({ endReason: 'connection-lost' }))).toBe('completed');
    expect(callOutcome(call({ endReason: 'connection-lost', answeredAt: null }))).toBe('missed');
  });

  it('records nothing for a call that never rang anyone', () => {
    expect(callOutcome(call({ endReason: 'unavailable', answeredAt: null }))).toBeNull();
  });

  it('summarises with the duration for completed calls', () => {
    const base = { callId: 'x', callerId: 'a', endReason: 'completed' as const };
    expect(
      callSummaryText({ ...base, media: 'video', outcome: 'completed', durationSec: 754 }),
    ).toBe('Video call · 12:34');
    expect(callSummaryText({ ...base, media: 'audio', outcome: 'missed', durationSec: null })).toBe(
      'Missed audio call',
    );
    expect(
      callSummaryText({ ...base, media: 'video', outcome: 'declined', durationSec: null }),
    ).toBe('Declined video call');
  });

  it('formats long calls with hours', () => {
    expect(formatCallDuration(3_725)).toBe('1:02:05');
    expect(formatCallDuration(5)).toBe('0:05');
  });
});

describe('CallHistoryService.record (CHAT-044)', () => {
  let realtime: {
    publishToConversation: ReturnType<typeof vi.fn>;
    publishToUser: ReturnType<typeof vi.fn>;
  };
  let service: CallHistoryService;
  const row = (overrides: Partial<MessageRow> = {}) =>
    ({
      id: '01J9ZQ3X4K7M8N9P0QRSTVWXYZ',
      seq: 7,
      conversationId: 'conv',
      senderId: 'caller',
      clientMsgId: null,
      type: 'call',
      body: 'x',
      replyToId: null,
      editedAt: null,
      deletedAt: null,
      createdAt: new Date(),
      meta: null,
      ...overrides,
    }) as MessageRow;

  const notifications = { notifyMissedCall: vi.fn() };

  beforeEach(() => {
    vi.resetAllMocks();
    notifications.notifyMissedCall.mockResolvedValue(undefined);
    realtime = {
      publishToConversation: vi.fn().mockResolvedValue(undefined),
      publishToUser: vi.fn().mockResolvedValue(undefined),
    };
    service = new CallHistoryService(
      {} as Database,
      realtime as unknown as RealtimeService,
      { onCallEnded: vi.fn() } as unknown as CallSignalingService,
      notifications as unknown as NotificationsService,
    );
    vi.mocked(appendMessageWithStatus).mockResolvedValue({ row: row(), created: true });
  });

  const published = (type: string) =>
    [...realtime.publishToConversation.mock.calls, ...realtime.publishToUser.mock.calls].filter(
      ([, env]) => (env as { type: string }).type === type,
    );

  it('posts a missed call idempotently, attributed to the caller, and leaves it unread', async () => {
    await service.record(call({ endReason: 'missed', answeredAt: null }));

    expect(appendMessageWithStatus).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        conversationId: 'conv',
        senderId: 'caller',
        clientMsgId: 'call:11111111-1111-4111-8111-111111111111',
        type: 'call',
        meta: { call: expect.objectContaining({ outcome: 'missed', durationSec: null }) },
      }),
    );
    expect(published('message.new')).toHaveLength(1);
    expect(markConversationRead).not.toHaveBeenCalled();
    expect(notifications.notifyMissedCall).toHaveBeenCalled();
  });

  it('marks an answered call read for the callee and tells their devices', async () => {
    vi.mocked(markConversationRead).mockResolvedValue({ lastReadSeq: 7 } as never);
    await service.record(call({ endReason: 'completed' }));
    expect(markConversationRead).toHaveBeenCalledWith({}, 'conv', 'callee', 7);
    // One per member with read receipts on (the callee's own devices included).
    expect(published('conversation.read').map(([to]) => to)).toEqual(['callee', 'caller']);
  });

  it('skips the read event when the callee is no longer a member', async () => {
    vi.mocked(markConversationRead).mockResolvedValue(undefined);
    await service.record(call({ endReason: 'declined', answeredAt: null }));
    expect(published('conversation.read')).toHaveLength(0);
  });

  it('records nothing for a silenced (blocked) call or one that never rang', async () => {
    await service.record(call({ silenced: true, endReason: 'missed', answeredAt: null }));
    await service.record(call({ endReason: 'unavailable', answeredAt: null }));
    expect(appendMessageWithStatus).not.toHaveBeenCalled();
    expect(realtime.publishToConversation).not.toHaveBeenCalled();
  });

  it('falls back to an unattributed entry when the caller has left, if the callee is still there', async () => {
    vi.mocked(appendMessageWithStatus)
      .mockRejectedValueOnce(new SenderNotAMemberError('conv'))
      .mockResolvedValueOnce({ row: row({ senderId: null }), created: true });
    vi.mocked(isConversationMember).mockResolvedValue(true);

    await service.record(call({ endReason: 'missed', answeredAt: null }));

    expect(isConversationMember).toHaveBeenCalledWith({}, 'conv', 'callee');
    expect(vi.mocked(appendMessageWithStatus).mock.calls[1]![1]).toMatchObject({ senderId: null });
    expect(published('message.new')).toHaveLength(1);
  });

  it('writes nothing when neither participant is still in the conversation', async () => {
    vi.mocked(appendMessageWithStatus).mockRejectedValueOnce(new SenderNotAMemberError('conv'));
    vi.mocked(isConversationMember).mockResolvedValue(false);

    await service.record(call({ endReason: 'missed', answeredAt: null }));

    expect(appendMessageWithStatus).toHaveBeenCalledTimes(1);
    expect(realtime.publishToConversation).not.toHaveBeenCalled();
  });

  it("doesn't re-announce an entry that already existed (a repeated record for the same call)", async () => {
    vi.mocked(appendMessageWithStatus).mockResolvedValue({ row: row(), created: false });
    vi.mocked(markConversationRead).mockResolvedValue({ lastReadSeq: 7 } as never);
    await service.record(call({ endReason: 'completed' }));
    expect(realtime.publishToConversation).not.toHaveBeenCalled();
    expect(markConversationRead).not.toHaveBeenCalled();
  });

  it('propagates other write errors (the signalling service catches them per listener)', async () => {
    vi.mocked(appendMessageWithStatus).mockRejectedValue(new Error('db down'));
    await expect(service.record(call({ endReason: 'missed', answeredAt: null }))).rejects.toThrow(
      'db down',
    );
  });
});
