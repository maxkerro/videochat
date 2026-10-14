import { Logger } from '@nestjs/common';
import type { Env } from '../config/env.js';
import type { Database } from '../db/client.js';
import type { CallRow } from '../db/schema.js';
import type { RealtimeService } from '../realtime/realtime.service.js';
import type { S3Service } from '../storage/s3.service.js';
import { CallSignalingService } from './call-signaling.service.js';

vi.mock('../db/calls.js', () => ({
  endExpiredCalls: vi.fn(),
  findDirectPeer: vi.fn(),
  findOpenCallForUser: vi.fn(),
  insertCall: vi.fn(),
  endCall: vi.fn(),
  getCall: vi.fn(),
  acceptCall: vi.fn(),
}));
vi.mock('../db/blocks.js', () => ({ isBlocked: vi.fn() }));
vi.mock('../db/users.js', () => ({
  findUserById: vi.fn(async () => ({ displayName: 'Anna', avatarKey: null })),
}));
import { isBlocked } from '../db/blocks.js';
import {
  acceptCall,
  endCall,
  endExpiredCalls,
  findDirectPeer,
  findOpenCallForUser,
  getCall,
  insertCall,
} from '../db/calls.js';

function expiredCall(id: string): CallRow {
  return {
    id,
    conversationId: 'conv',
    callerId: 'caller',
    calleeId: 'callee',
    media: 'audio',
    status: 'ended',
    endReason: 'missed',
    callerConnectionId: 'c1',
    calleeConnectionId: null,
    callerDisconnectedAt: null,
    calleeDisconnectedAt: null,
    silenced: false,
    createdAt: new Date(),
    answeredAt: null,
    endedAt: new Date(),
  };
}

describe('CallSignalingService.sweep', () => {
  let realtime: { publishToUser: ReturnType<typeof vi.fn> };
  let service: CallSignalingService;
  let warn: ReturnType<typeof vi.spyOn>;
  let log: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    realtime = { publishToUser: vi.fn().mockResolvedValue(undefined) };
    service = new CallSignalingService(
      {} as Database,
      { CALL_RING_TIMEOUT_SEC: 30, CALL_RECONNECT_GRACE_SEC: 20 } as Env,
      realtime as unknown as RealtimeService,
      {} as S3Service,
    );
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('logs a failing sweep once per streak, not every second, and notes recovery', async () => {
    vi.mocked(endExpiredCalls).mockRejectedValue(
      Object.assign(new Error('Failed query: update "calls" ...'), {
        cause: { message: 'relation "calls" does not exist' },
      }),
    );

    await service.sweep();
    await service.sweep();
    await service.sweep();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/relation "calls" does not exist/);

    vi.mocked(endExpiredCalls).mockResolvedValue([]);
    await service.sweep();
    expect(log).toHaveBeenCalledWith('Call sweep recovered');

    vi.mocked(endExpiredCalls).mockRejectedValue(new Error('down again'));
    await service.sweep();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('still announces the rest of a batch when one announcement fails, without calling it an outage', async () => {
    vi.mocked(endExpiredCalls).mockResolvedValue([expiredCall('a'), expiredCall('b')]);
    realtime.publishToUser.mockRejectedValueOnce(new Error('redis publish failed'));

    await service.sweep();

    const announced = realtime.publishToUser.mock.calls.map(
      ([, env]) => (env as { payload: { callId: string } }).payload.callId,
    );
    expect(announced).toContain('b');
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/call a/));
    expect(warn).not.toHaveBeenCalledWith(expect.stringMatching(/sweep failing/i));

    vi.mocked(endExpiredCalls).mockResolvedValue([]);
    await service.sweep();
    expect(log).not.toHaveBeenCalledWith('Call sweep recovered');
  });

  it("isolates one call's failing listener from the next call", async () => {
    vi.mocked(endExpiredCalls).mockResolvedValue([expiredCall('a'), expiredCall('b')]);
    const seen: string[] = [];
    service.onCallEnded(async (call) => {
      if (call.id === 'a') throw new Error('history write failed');
      seen.push(call.id);
    });

    await service.sweep();

    expect(seen).toEqual(['b']);
  });

  it('isolates listeners from each other, including a synchronous throw', async () => {
    vi.mocked(endExpiredCalls).mockResolvedValue([expiredCall('a')]);
    const second = vi.fn().mockResolvedValue(undefined);
    service.onCallEnded((() => {
      throw new Error('sync boom');
    }) as never);
    service.onCallEnded(second);

    await service.sweep();

    expect(second).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/listener failed for a: sync boom/));
  });

  it('still runs the listeners (call history) when publishing call.ended fails', async () => {
    vi.mocked(endExpiredCalls).mockResolvedValue([expiredCall('a')]);
    realtime.publishToUser.mockRejectedValue(new Error('redis publish failed'));
    const listener = vi.fn().mockResolvedValue(undefined);
    service.onCallEnded(listener);

    await service.sweep();

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }));
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/publish the end of call a/));
  });
});

describe('CallSignalingService invite -> incoming-call listener (CHAT-061)', () => {
  const CALL = '11111111-1111-4111-8111-111111111111';
  const CONV = '22222222-2222-4222-8222-222222222222';
  let service: CallSignalingService;
  let listener: ReturnType<typeof vi.fn>;
  const client = { userId: 'caller', connectionId: 'c1', readyState: 1, OPEN: 1, send: vi.fn() };
  const invite = () =>
    service.handle(
      client as never,
      {
        type: 'call.invite',
        id: 'e1',
        ts: new Date().toISOString(),
        payload: { callId: CALL, conversationId: CONV, media: 'audio' },
      } as never,
    );

  beforeEach(() => {
    vi.clearAllMocks();
    const realtime = { publishToUser: vi.fn().mockResolvedValue(undefined) };
    service = new CallSignalingService(
      {} as Database,
      { CALL_RING_TIMEOUT_SEC: 30, CALL_RECONNECT_GRACE_SEC: 20 } as Env,
      realtime as unknown as RealtimeService,
      { getAvatarUrl: vi.fn(async () => null) } as unknown as S3Service,
    );
    listener = vi.fn().mockResolvedValue(undefined);
    service.onCallIncoming(listener as never);
    vi.mocked(findDirectPeer).mockResolvedValue({ id: 'callee' } as never);
    vi.mocked(isBlocked).mockResolvedValue(false);
    vi.mocked(findOpenCallForUser).mockResolvedValue(undefined as never);
    vi.mocked(insertCall).mockImplementation(
      async (_db, v) => ({ ...v, id: v.id, status: 'ringing' }) as never,
    );
    vi.mocked(endCall).mockResolvedValue(undefined as never);
  });

  it('rings the callee by push once for a normal call', async () => {
    await invite();
    await new Promise((r) => setTimeout(r, 0));
    expect(listener).toHaveBeenCalledOnce();
    expect(listener.mock.calls[0]![0]).toMatchObject({ id: CALL, conversationId: CONV });
  });

  it('does not wake a phone that blocked the caller (silenced call)', async () => {
    vi.mocked(isBlocked).mockImplementation(async (_db, blocker) => blocker === 'callee');
    vi.mocked(insertCall).mockImplementation(
      async (_db, v) => ({ ...v, status: 'ringing', silenced: true }) as never,
    );
    await invite();
    await new Promise((r) => setTimeout(r, 0));
    expect(listener).not.toHaveBeenCalled();
  });

  it('does not push for a callee who is busy, or a caller who is blocked', async () => {
    vi.mocked(findOpenCallForUser).mockImplementation(async (_db, user) =>
      user === 'callee' ? ({ id: 'other' } as never) : (undefined as never),
    );
    await invite();
    vi.mocked(findOpenCallForUser).mockResolvedValue(undefined as never);
    vi.mocked(isBlocked).mockImplementation(async (_db, blocker) => blocker === 'caller');
    await invite();
    await new Promise((r) => setTimeout(r, 0));
    expect(listener).not.toHaveBeenCalled();
  });

  it('does not wait for a slow push before returning', async () => {
    listener.mockReturnValue(new Promise(() => undefined));
    await expect(invite()).resolves.toBeUndefined();
  });
});

describe('CallSignalingService: a late decline (CHAT-061)', () => {
  it('leaves a call that already rang out as missed', async () => {
    vi.clearAllMocks();
    const service = new CallSignalingService(
      {} as Database,
      { CALL_RING_TIMEOUT_SEC: 30, CALL_RECONNECT_GRACE_SEC: 20 } as Env,
      { publishToUser: vi.fn() } as unknown as RealtimeService,
      {} as S3Service,
    );
    vi.mocked(getCall).mockResolvedValue({ ...expiredCall('a'), endReason: 'missed' });
    await service.handle(
      { userId: 'callee', connectionId: 'c2' } as never,
      {
        type: 'call.decline',
        id: 'e',
        ts: new Date().toISOString(),
        payload: { callId: '11111111-1111-4111-8111-111111111111' },
      } as never,
    );
    expect(endCall).not.toHaveBeenCalled();
  });
});

describe('CallSignalingService: only the callee may answer, decline or ring (CHAT-061)', () => {
  const CALL = '11111111-1111-4111-8111-111111111111';
  let realtime: {
    publishToUser: ReturnType<typeof vi.fn>;
    publishToConnection: ReturnType<typeof vi.fn>;
  };
  let service: CallSignalingService;
  const ringing = {
    ...expiredCall(CALL),
    status: 'ringing',
    endReason: null,
    endedAt: null,
  } as CallRow;
  const send = (type: string, userId = 'stranger') =>
    service.handle(
      { userId, connectionId: 'c9' } as never,
      {
        type,
        id: 'e',
        ts: new Date().toISOString(),
        payload: { callId: CALL },
      } as never,
    );

  beforeEach(() => {
    vi.clearAllMocks();
    realtime = {
      publishToUser: vi.fn().mockResolvedValue(undefined),
      publishToConnection: vi.fn().mockResolvedValue(undefined),
    };
    service = new CallSignalingService(
      {} as Database,
      { CALL_RING_TIMEOUT_SEC: 30, CALL_RECONNECT_GRACE_SEC: 20 } as Env,
      realtime as unknown as RealtimeService,
      {} as S3Service,
    );
    vi.mocked(getCall).mockResolvedValue(ringing);
    // The real UPDATE matches on callee_id and status = 'ringing'; a stranger matches nothing.
    vi.mocked(acceptCall).mockResolvedValue(undefined);
  });

  it("ignores a third user's decline, cancel and end", async () => {
    await send('call.decline');
    await send('call.cancel');
    await send('call.end');
    expect(endCall).not.toHaveBeenCalled();
    expect(realtime.publishToUser).not.toHaveBeenCalled();
  });

  it("ignores a third user's accept: nothing is told to anyone", async () => {
    await send('call.accept');
    expect(acceptCall).toHaveBeenCalledWith({}, CALL, 'stranger', 'c9');
    expect(realtime.publishToUser).not.toHaveBeenCalled();
    expect(realtime.publishToConnection).not.toHaveBeenCalled();
  });

  it("ignores a third user's ringing", async () => {
    await send('call.ringing');
    expect(realtime.publishToConnection).not.toHaveBeenCalled();
  });

  it('still lets the callee decline', async () => {
    vi.mocked(endCall).mockResolvedValue({ ...ringing, status: 'ended', endReason: 'declined' });
    await send('call.decline', 'callee');
    expect(endCall).toHaveBeenCalledWith({}, CALL, 'declined', ['ringing']);
  });
});
