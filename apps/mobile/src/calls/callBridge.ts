import type { CallMedia } from '@videochat/shared';
import type { CallEndCause, CallPeer, CallSnapshot, IncomingCallInfo } from './CallEngine';

/** What the bridge needs to know about the system's view of a call. */
export interface NativeSession {
  id: string;
  origin: 'incoming' | 'outgoingApp' | 'outgoingSystem';
  status: 'requesting' | 'connecting' | 'ringing' | 'connected' | 'ended';
  incomingCallEvent?: {
    eventId: string;
    serverCallId: string;
    hasVideo: boolean;
    startedAt?: string;
    caller: { id: string; displayName?: string; avatarUrl?: string };
    metadata?: Record<string, unknown>;
  };
}

export type NativeEndReason =
  'failed' | 'remoteEnded' | 'unanswered' | 'answeredElsewhere' | 'declinedElsewhere' | 'unknown';

export interface NativeHandlers {
  sessionAdded(session: NativeSession): void;
  answered(event: { id: string; requestId: string }): void;
  /** The person ended (or declined) the call from the system call screen. */
  ended(event: { id: string; session?: NativeSession }): void;
  muted(event: { id: string; isMuted: boolean }): void;
}

/** The small part of the native call library (CallKit / Telecom) the bridge uses. */
export interface NativeCallApi {
  reportIncoming(event: NonNullable<NativeSession['incomingCallEvent']>): Promise<void>;
  startOutgoing(recipient: CallPeer, hasVideo: boolean): Promise<string>;
  reportOutgoingConnected(id: string): Promise<void>;
  answer(id: string): Promise<void>;
  fulfillAnswered(requestId: string): Promise<void>;
  failAnswered(id: string, requestId: string): Promise<void>;
  reportEnded(id: string, reason: NativeEndReason): Promise<void>;
  end(id: string): Promise<void>;
  setMuted(id: string, muted: boolean): Promise<void>;
  activeSession(): Promise<NativeSession | null>;
  listen(handlers: NativeHandlers): () => void;
}

/** The part of the call engine the bridge drives. */
export interface BridgeEngine {
  getSnapshot(): CallSnapshot | null;
  presentIncoming(info: IncomingCallInfo): boolean;
  decline(): void;
  hangUp(): void;
  abandonIncoming(): void;
  setAudioEnabled(enabled: boolean): void;
}

export interface BridgeDeps {
  api: NativeCallApi;
  engine: BridgeEngine;
  waitForSignalling(): Promise<boolean>;
  now(): number;
  /** The server's ring timeout; a system call screen that ends this long after it began rang out
   *  rather than being declined. */
  ringTimeoutMs?: number;
}

export const RING_TIMEOUT_MS = 30_000;
/** Slack for clocks and delivery delay when deciding whether a ring ran out. */
const RING_SLACK_MS = 2_000;

/** The reason the system records for a call the other side or the server ended. */
export function nativeEndReason(cause: CallEndCause | null): NativeEndReason {
  switch (cause) {
    case 'answered-elsewhere':
      return 'answeredElsewhere';
    case 'missed':
      return 'unanswered';
    case 'failed':
    case 'connection-lost':
      return 'failed';
    case null:
      return 'unknown';
    default:
      return 'remoteEnded';
  }
}

function conversationOf(event: NonNullable<NativeSession['incomingCallEvent']>): string | null {
  const value = event.metadata?.conversationId;
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** What the engine needs to show a call the system already rings for; null if the push did not
 *  carry enough to place it in a conversation. */
export function incomingInfoOf(session: NativeSession | undefined): IncomingCallInfo | null {
  const event = session?.incomingCallEvent;
  if (!event) return null;
  const conversationId = conversationOf(event);
  if (!conversationId) return null;
  return {
    callId: event.serverCallId,
    conversationId,
    media: event.hasVideo ? 'video' : 'audio',
    caller: {
      id: event.caller.id,
      displayName: event.caller.displayName ?? '',
      avatarUrl: event.caller.avatarUrl ?? null,
    },
  };
}

/**
 * CHAT-061: keeps the phone's own call screen (CallKit on iOS, Telecom on Android) and the call
 * engine in step.
 *
 *  - An incoming call is reported to the system, which rings on the lock screen. If a push already
 *    did that (the app was closed), the existing system call is adopted instead.
 *  - Answering or declining on the system screen drives the engine; the engine ending (the caller
 *    hung up, another device answered) ends the system call with the right reason.
 *  - Outgoing calls are registered too, so Android keeps the microphone alive in the background.
 *
 * Every system call is an error-tolerant extra: if the native side refuses, the call carries on in
 * the app's own screen.
 */
export class CallBridge {
  private readonly osIds = new Map<string, string>();
  private readonly sessions = new Map<string, NativeSession>();
  private readonly requestIds = new Map<string, string>();
  private readonly ringStart = new Map<string, number>();
  private readonly registered = new Set<string>();
  private readonly connectedReported = new Set<string>();
  private readonly endHandled = new Set<string>();
  private readonly localEnd = new Set<string>();
  private readonly lastMuted = new Map<string, boolean>();
  /** What the person asked for when answering in the app ("audio only" on a video call). */
  private readonly requestedMedia = new Map<string, CallMedia>();
  private stopListening: (() => void) | null = null;
  private answerer: (media: CallMedia) => Promise<boolean> = async () => false;

  constructor(private readonly deps: BridgeDeps) {}

  /** How to answer the engine's ringing call (microphone permission, then `call.accept`); resolves
   *  false when it could not. */
  setAnswerer(answerer: (media: CallMedia) => Promise<boolean>): void {
    this.answerer = answerer;
  }

  async start(): Promise<void> {
    if (this.stopListening) return;
    this.stopListening = this.deps.api.listen({
      sessionAdded: (session) => this.mapSession(session),
      answered: (event) => void this.onAnswered(event),
      ended: (event) => void this.onNativeEnded(event),
      muted: (event) => this.onMuted(event),
    });
    await this.adoptActiveSession();
  }

  stop(): void {
    this.stopListening?.();
    this.stopListening = null;
  }

  /** The app's own screen is ending the call (decline, cancel, hang up): the system call ends as
   *  "ended by me" rather than "ended by them". */
  noteLocalEnd(): void {
    const snap = this.deps.engine.getSnapshot();
    if (snap) this.localEnd.add(snap.callId);
  }

  /** Answer through the system so it knows the call was taken; the answer event then comes back
   *  here. False if the system does not have this call (answer directly then). */
  requestAnswer(media?: CallMedia): boolean {
    const snap = this.deps.engine.getSnapshot();
    const osId = snap ? this.osIds.get(snap.callId) : undefined;
    if (!snap || !osId || snap.phase !== 'incoming') return false;
    const kind = media ?? snap.media;
    this.requestedMedia.set(snap.callId, kind);
    // If the system will not take the answer, answer directly.
    void this.deps.api.answer(osId).catch(() => this.answerer(kind));
    return true;
  }

  /** Feeds every engine change in. */
  onSnapshot(snap: CallSnapshot | null): void {
    if (!snap) return;
    const id = snap.callId;
    if (snap.phase === 'ended') {
      void this.finishNative(snap);
      return;
    }
    if (!this.registered.has(id)) {
      this.registered.add(id);
      void this.register(snap);
    }
    const osId = this.osIds.get(id);
    if (!osId) return;

    if (snap.startedAt !== null && !this.connectedReported.has(id)) {
      const requestId = this.requestIds.get(id);
      if (snap.direction === 'outgoing') {
        this.connectedReported.add(id);
        void this.deps.api.reportOutgoingConnected(osId).catch(() => undefined);
      } else if (requestId) {
        this.connectedReported.add(id);
        void this.deps.api.fulfillAnswered(requestId).catch(() => undefined);
      }
    }
    if (snap.localStream) {
      const muted = !snap.audioEnabled;
      if ((this.lastMuted.get(id) ?? false) !== muted) {
        this.lastMuted.set(id, muted);
        void this.deps.api.setMuted(osId, muted).catch(() => undefined);
      }
    }
  }

  // --- engine -> system ---------------------------------------------------------------------

  private async register(snap: CallSnapshot): Promise<void> {
    const id = snap.callId;
    if (snap.direction === 'incoming') {
      if (!this.ringStart.has(id)) this.ringStart.set(id, this.deps.now());
      try {
        await this.deps.api.reportIncoming({
          eventId: id,
          serverCallId: id,
          hasVideo: snap.media === 'video',
          startedAt: new Date(this.deps.now()).toISOString(),
          caller: {
            id: snap.peer.id,
            displayName: snap.peer.displayName,
            ...(snap.peer.avatarUrl ? { avatarUrl: snap.peer.avatarUrl } : {}),
          },
          metadata: { conversationId: snap.conversationId },
        });
      } catch {
        // Most likely the push already reported it (one system call at a time): adopt that one.
      }
      await this.adoptActiveSession();
    } else {
      try {
        const osId = await this.deps.api.startOutgoing(snap.peer, snap.media === 'video');
        this.osIds.set(id, osId);
      } catch {
        return; // The call goes on without the system's help.
      }
    }
    const osId = this.osIds.get(id);
    if (!osId) return;
    const current = this.deps.engine.getSnapshot();
    if (current && current.callId === id) this.onSnapshot(current);
    else void this.deps.api.end(osId).catch(() => undefined); // it ended while being registered
  }

  private async finishNative(snap: CallSnapshot): Promise<void> {
    const id = snap.callId;
    const osId = this.osIds.get(id);
    if (!osId || this.endHandled.has(id)) return;
    this.endHandled.add(id);
    const requestId = this.requestIds.get(id);
    try {
      if (requestId && !this.connectedReported.has(id)) {
        // Answered on the system screen but never got connected.
        await this.deps.api.failAnswered(osId, requestId);
      } else if (this.localEnd.has(id)) {
        await this.deps.api.end(osId);
      } else {
        await this.deps.api.reportEnded(osId, nativeEndReason(snap.endCause));
      }
    } catch {
      // The system call may already be gone.
    }
    this.forget(id);
  }

  private forget(id: string): void {
    const osId = this.osIds.get(id);
    this.osIds.delete(id);
    if (osId) this.sessions.delete(osId);
    this.requestIds.delete(id);
    this.ringStart.delete(id);
    this.registered.delete(id);
    this.connectedReported.delete(id);
    this.endHandled.delete(id);
    this.localEnd.delete(id);
    this.lastMuted.delete(id);
    this.requestedMedia.delete(id);
  }

  // --- system -> engine ---------------------------------------------------------------------

  private mapSession(session: NativeSession): void {
    this.sessions.set(session.id, session);
    const event = session.incomingCallEvent;
    if (event) this.osIds.set(event.serverCallId, session.id);
  }

  private callIdOf(osId: string): string | null {
    for (const [callId, id] of this.osIds) if (id === osId) return callId;
    return this.sessions.get(osId)?.incomingCallEvent?.serverCallId ?? null;
  }

  /** Picks up the call the system is already ringing for, if any (the app was started by it). */
  private async adoptActiveSession(): Promise<void> {
    const session = await this.deps.api.activeSession().catch(() => null);
    if (!session || session.status === 'ended') return;
    this.mapSession(session);
    if (session.origin !== 'incoming') return;
    const info = incomingInfoOf(session);
    if (info && this.deps.engine.getSnapshot() === null) {
      // Local time, not the push's `startedAt`: the two clocks may differ. (A ring picked up late
      // is judged as if it began now, which only errs towards "declined".)
      this.ringStart.set(info.callId, this.deps.now());
      this.deps.engine.presentIncoming(info);
    }
  }

  private async onAnswered(event: { id: string; requestId: string }): Promise<void> {
    const callId = this.callIdOf(event.id);
    if (!callId) {
      void this.deps.api.failAnswered(event.id, event.requestId).catch(() => undefined);
      return;
    }
    this.requestIds.set(callId, event.requestId);
    let snap = this.deps.engine.getSnapshot();
    if (!snap || snap.callId !== callId) {
      // The app was started by the answer: the call is only known from the push.
      const info = incomingInfoOf(this.sessions.get(event.id));
      if (!info || !this.deps.engine.presentIncoming(info)) return this.failAnswer(event);
      snap = this.deps.engine.getSnapshot();
    }
    if (!snap || snap.phase !== 'incoming') return;
    // An answer asked for in the app keeps its choice (audio only); one from the system screen
    // follows the call.
    const ok = await this.answerer(this.requestedMedia.get(callId) ?? snap.media).catch(
      () => false,
    );
    if (!ok) this.failAnswer(event);
  }

  private failAnswer(event: { id: string; requestId: string }): void {
    void this.deps.api.failAnswered(event.id, event.requestId).catch(() => undefined);
    const snap = this.deps.engine.getSnapshot();
    if (snap && snap.phase === 'incoming') this.deps.engine.decline();
  }

  private async onNativeEnded(event: { id: string; session?: NativeSession }): Promise<void> {
    if (event.session) this.mapSession(event.session);
    const callId = this.callIdOf(event.id);
    if (!callId) return;
    const engine = this.deps.engine;
    const snap = engine.getSnapshot();
    if (snap && snap.callId === callId) {
      if (snap.phase === 'ended') return;
      this.localEnd.add(callId);
      if (snap.phase !== 'incoming') engine.hangUp();
      else if (this.ringedOut(callId)) engine.abandonIncoming();
      else engine.decline();
      return;
    }
    // The app started after the person declined on the lock screen: still tell the server, so the
    // caller stops ringing instead of waiting for the timeout.
    const info = incomingInfoOf(event.session ?? this.sessions.get(event.id));
    if (!info || this.requestIds.has(callId) || this.ringedOut(callId)) return;
    if (!(await this.deps.waitForSignalling())) return;
    if (engine.getSnapshot() === null && engine.presentIncoming(info)) engine.decline();
  }

  private ringedOut(callId: string): boolean {
    const began = this.ringStart.get(callId);
    if (began === undefined) return false;
    const limit = (this.deps.ringTimeoutMs ?? RING_TIMEOUT_MS) - RING_SLACK_MS;
    return this.deps.now() - began >= limit;
  }

  private onMuted(event: { id: string; isMuted: boolean }): void {
    const callId = this.callIdOf(event.id);
    const snap = this.deps.engine.getSnapshot();
    if (callId && snap && snap.callId === callId) {
      this.lastMuted.set(callId, event.isMuted);
      this.deps.engine.setAudioEnabled(!event.isMuted);
    }
  }
}
