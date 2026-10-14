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
  findRunningGroupCall: vi.fn(),
}));
import { endGroupCalls, findRunningGroupCall } from '../db/group-calls.js';

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

describe('identities', () => {
  it('ties each connection to its user', async () => {
    const { connectionIdentity, userOfIdentity } = await import('./sfu.js');
    const id = connectionIdentity('3f0c9c7e-2b2c-4d5a-9f55-0d3b8f1a2b3c', 'device-1');
    expect(userOfIdentity(id)).toBe('3f0c9c7e-2b2c-4d5a-9f55-0d3b8f1a2b3c');
    expect(userOfIdentity('legacy-no-suffix')).toBe('legacy-no-suffix');
  });
});

describe('GroupCallsService.removeFromCall', () => {
  it("removes every connection of that person and leaves everyone else's alone", async () => {
    vi.mocked(findRunningGroupCall).mockResolvedValue({ id: 'room' } as never);
    const sfu = {
      enabled: true,
      listIdentities: vi.fn(async () => ['ben:a', 'ben:b', 'anna:a', 'benjamin:a']),
      removeIdentity: vi.fn(async (_room: string, _identity: string) => undefined),
    };
    const service = new GroupCallsService(
      {} as Database,
      sfu as unknown as Sfu,
      {} as RealtimeService,
    );
    await service.removeFromCall('conv', 'ben');
    expect(sfu.removeIdentity.mock.calls.map((c) => c[1])).toEqual(['ben:a', 'ben:b']);
  });
});
