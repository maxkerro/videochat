import { Logger } from '@nestjs/common';
import type { Env } from '../config/env.js';
import type { Database } from '../db/client.js';
import type { RealtimeService } from '../realtime/realtime.service.js';
import type { S3Service } from '../storage/s3.service.js';
import { CallSignalingService } from './call-signaling.service.js';

vi.mock('../db/calls.js', () => ({ endExpiredCalls: vi.fn() }));
import { endExpiredCalls } from '../db/calls.js';

describe('CallSignalingService.sweep', () => {
  const service = new CallSignalingService(
    {} as Database,
    { CALL_RING_TIMEOUT_SEC: 30, CALL_RECONNECT_GRACE_SEC: 20 } as Env,
    {} as RealtimeService,
    {} as S3Service,
  );

  it('logs a failing sweep once per streak, not every second, and notes recovery', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
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
});
