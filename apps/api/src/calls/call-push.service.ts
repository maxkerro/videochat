import { Injectable, type OnModuleInit } from '@nestjs/common';
import { NotificationsService } from '../notifications/notifications.service.js';
import { CallSignalingService } from './call-signaling.service.js';

/**
 * CHAT-061: when a call starts ringing, also wake the callee's phones through push so the system
 * call screen appears with the app closed or the phone locked. Open apps and web tabs ring from the
 * realtime `call.incoming` event; the phone de-duplicates the two by call id.
 *
 * Apple requires every VoIP push to show a call, so on iOS this stays off until there are APNs
 * credentials (see docs/MOBILE.md) and a VoIP push is never used for anything but calls.
 */
@Injectable()
export class CallPushService implements OnModuleInit {
  constructor(
    private readonly signaling: CallSignalingService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    this.signaling.onCallIncoming((call, caller) =>
      this.notifications.notifyIncomingCall(call.calleeId, {
        callId: call.id,
        conversationId: call.conversationId,
        hasVideo: call.media === 'video',
        startedAt: call.createdAt.toISOString(),
        caller,
      }),
    );
  }
}
