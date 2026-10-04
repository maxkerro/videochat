import { Logger } from '@nestjs/common';
import type { Env } from '../config/env.js';
import type { Database } from '../db/client.js';
import type { CallRow } from '../db/schema.js';
import type { RealtimeService } from '../realtime/realtime.service.js';
import type { S3Service } from '../storage/s3.service.js';
import { CallSignalingService } from './call-signaling.service.js';

vi.mock('../db/calls.js', () => ({ endExpiredCalls: vi.fn() }));
import { endExpiredCalls } from '../db/calls.js';

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

  it('isolates a failing call-ended listener (e.g. call history) from the others', async () => {
    vi.mocked(endExpiredCalls).mockResolvedValue([expiredCall('a'), expiredCall('b')]);
    const seen: string[] = [];
    service.onCallEnded(async (call) => {
      if (call.id === 'a') throw new Error('history write failed');
      seen.push(call.id);
    });

    await service.sweep();

    expect(seen).toEqual(['b']);
  });
});
