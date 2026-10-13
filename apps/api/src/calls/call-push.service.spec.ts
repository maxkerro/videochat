import type { CallRow } from '../db/schema.js';
import type { NotificationsService } from '../notifications/notifications.service.js';
import { CallPushService } from './call-push.service.js';
import type { CallIncomingListener, CallSignalingService } from './call-signaling.service.js';

describe('CallPushService (CHAT-061)', () => {
  it('rings the callee with the conversation, kind and start time of the call', async () => {
    let listener!: CallIncomingListener;
    const signaling = {
      onCallIncoming: (l: CallIncomingListener) => (listener = l),
    } as unknown as CallSignalingService;
    const notifyIncomingCall = vi.fn().mockResolvedValue(undefined);
    new CallPushService(signaling, {
      notifyIncomingCall,
    } as unknown as NotificationsService).onModuleInit();

    const caller = { id: 'anna', displayName: 'Anna', avatarUrl: null };
    await listener(
      {
        id: 'call-1',
        conversationId: 'conv-1',
        calleeId: 'ben',
        media: 'video',
        createdAt: new Date('2026-10-13T10:00:00.000Z'),
      } as CallRow,
      caller,
    );

    expect(notifyIncomingCall).toHaveBeenCalledWith('ben', {
      callId: 'call-1',
      conversationId: 'conv-1',
      hasVideo: true,
      startedAt: '2026-10-13T10:00:00.000Z',
      caller,
    });
  });
});
