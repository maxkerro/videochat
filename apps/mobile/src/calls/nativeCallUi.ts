import * as Calls from 'expo-callkit-telecom';
import type { NativeCallApi, NativeSession } from './callBridge';

/**
 * CHAT-061: the native call library (CallKit on iOS, Android Telecom) behind the small interface
 * the call bridge uses. The only file that imports it besides the audio driver.
 */
export const nativeCallApi: NativeCallApi = {
  reportIncoming: (event) => Calls.reportIncomingCall(event as Calls.IncomingCallEvent),
  startOutgoing: (recipient, hasVideo) =>
    Calls.startOutgoingCall(
      {
        id: recipient.id,
        displayName: recipient.displayName,
        ...(recipient.avatarUrl ? { avatarUrl: recipient.avatarUrl } : {}),
      },
      { hasVideo },
    ),
  reportOutgoingConnected: (id) => Calls.reportOutgoingCallConnected(id),
  answer: (id) => Calls.answerCall(id),
  fulfillAnswered: (requestId) => Calls.fulfillIncomingCallConnected(requestId),
  failAnswered: (id, requestId) => Calls.failIncomingCallConnected(id, requestId),
  reportEnded: (id, reason) => Calls.reportCallEnded(id, reason),
  end: (id) => Calls.endCall(id),
  setMuted: (id, muted) => Calls.setMuted(id, muted),
  activeSession: async () => (await Calls.getActiveCallSession()) as NativeSession | null,
  listen: (handlers) => {
    const subscriptions = [
      Calls.addCallSessionAddedListener((e) => handlers.sessionAdded(e.session as NativeSession)),
      Calls.addCallAnsweredListener((e) => handlers.answered({ id: e.id, requestId: e.requestId })),
      Calls.addCallEndedListener((e) =>
        handlers.ended({ id: e.id, session: e.session as NativeSession }),
      ),
      Calls.addSetMutedActionListener((e) => handlers.muted({ id: e.id, isMuted: e.isMuted })),
    ];
    return () => subscriptions.forEach((s) => s.remove());
  },
};
