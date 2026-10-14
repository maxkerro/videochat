import { Logger } from '@nestjs/common';
import type { Database } from '../db/client.js';
import type { RealtimeService } from '../realtime/realtime.service.js';
import { GroupCallsService } from './group-calls.service.js';
import { controlUrl, type Sfu } from './sfu.js';

vi.mock('../db/group-calls.js', () => ({
  listRunningGroupCalls: vi.fn(async () => [
    { id: 'a', conversationId: 'c', startedAt: new Date(0), participantCount: 1 },
  ]),
  endGroupCalls: vi.fn(async () => []),
  setGroupCallParticipants: vi.fn(),
}));
import { endGroupCalls } from '../db/group-calls.js';

describe('controlUrl', () => {
  it('turns the client URL into the control API URL', () => {
    expect(controlUrl('wss://x.livekit.cloud')).toBe('https://x.livekit.cloud');
    expect(controlUrl('ws://localhost:7880')).toBe('http://localhost:7880');
    expect(controlUrl('https://x.livekit.cloud')).toBe('https://x.livekit.cloud');
  });
});

describe('GroupCallsService.sweep', () => {
  afterEach(() => vi.restoreAllMocks());

  it('ends nothing when the SFU cannot be asked, and logs that once per streak', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    const sfu = { enabled: true, listRooms: vi.fn().mockRejectedValue(new Error('down')) };
    const service = new GroupCallsService(
      {} as Database,
      sfu as unknown as Sfu,
      {} as RealtimeService,
    );
    await service.sweep();
    await service.sweep();
    expect(endGroupCalls).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does not run at all when group calls are not set up', () => {
    const setInterval = vi.spyOn(globalThis, 'setInterval');
    new GroupCallsService(
      {} as Database,
      { enabled: false } as unknown as Sfu,
      {} as RealtimeService,
    ).onModuleInit();
    expect(setInterval).not.toHaveBeenCalled();
  });
});
