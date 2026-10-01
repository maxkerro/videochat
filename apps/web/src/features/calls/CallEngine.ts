import {
  CALL_EVENTS,
  callAcceptedSchema,
  callEndedSchema,
  callIceSchema,
  callIncomingSchema,
  callMediaStateSchema,
  callRefSchema,
  callSdpSchema,
  type CallEndReason,
  type CallMedia,
  type IceServer,
  type WsEnvelope,
} from '@videochat/shared';

export type CallPhase =
  'outgoing' | 'incoming' | 'connecting' | 'active' | 'reconnecting' | 'ended';

/** Why a call is over from this device's point of view: the server's reason, or one only this
 *  device knows (another of my devices answered; my own media/connection failed). */
export type CallEndCause = CallEndReason | 'answered-elsewhere' | 'failed';

export interface CallPeer {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}

/** Immutable view of the current call; a new object on every change (for useSyncExternalStore). */
export interface CallSnapshot {
  callId: string;
  conversationId: string;
  peer: CallPeer;
  media: CallMedia;
  direction: 'outgoing' | 'incoming';
  phase: CallPhase;
  /** Outgoing only: at least one of the callee's devices is ringing. */
  calleeRinging: boolean;
  /** When media first connected (ms since epoch), for the call timer. */
  startedAt: number | null;
  localStream: MediaStream | null;
  remoteStream: MediaStream | null;
  audioEnabled: boolean;
  videoEnabled: boolean;
  /** The other side's mute/camera state, relayed via `call.media`. */
  remoteAudioEnabled: boolean;
  remoteVideoEnabled: boolean;
  endCause: CallEndCause | null;
}

export interface CallEngineDeps {
  send: (type: string, payload: unknown) => void;
  getConnectionId: () => string | null;
  getIceServers: () => Promise<IceServer[]>;
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createPeerConnection: (config: RTCConfiguration) => RTCPeerConnection;
  createMediaStream: () => MediaStream;
  now: () => number;
  newCallId: () => string;
}

export class CallBusyError extends Error {
  constructor() {
    super('Already in a call');
    this.name = 'CallBusyError';
  }
}

/**
 * CHAT-042: one device's side of a 1:1 call -- the signalling state machine (CHAT-041 events in,
 * events out) plus the RTCPeerConnection.
 *
 * Negotiation uses the standard WebRTC "perfect negotiation" pattern (the callee is the polite
 * peer): either side can (re)negotiate at any time -- turning a camera on in an audio call, an
 * ICE restart after a network change (CHAT-043) -- and an offer collision resolves itself
 * without a deadlock.
 */
export class CallEngine {
  private snap: CallSnapshot | null = null;
  private readonly listeners = new Set<() => void>();
  private pc: RTCPeerConnection | null = null;
  private polite = false;
  private makingOffer = false;
  private ignoreOffer = false;
  private pendingSignals: WsEnvelope[] = [];
  private signalChain: Promise<void> = Promise.resolve();
  private iceServers: Promise<IceServer[]> | null = null;

  constructor(private readonly deps: CallEngineDeps) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): CallSnapshot | null => this.snap;

  /** True while a call is in progress (anything but ended/none). */
  isBusy(): boolean {
    return this.snap !== null && this.snap.phase !== 'ended';
  }

  /** Places a call. `stream` comes from the pre-join check; the engine owns it from here on. */
  startOutgoing(args: {
    conversationId: string;
    peer: CallPeer;
    media: CallMedia;
    stream: MediaStream;
  }): string {
    if (this.isBusy()) throw new CallBusyError();
    const callId = this.deps.newCallId();
    this.reset();
    this.polite = false;
    this.iceServers = this.fetchIceServers();
    this.snap = {
      callId,
      conversationId: args.conversationId,
      peer: args.peer,
      media: args.media,
      direction: 'outgoing',
      phase: 'outgoing',
      calleeRinging: false,
      startedAt: null,
      localStream: args.stream,
      remoteStream: this.deps.createMediaStream(),
      audioEnabled: true,
      videoEnabled: args.stream.getVideoTracks().length > 0,
      remoteAudioEnabled: true,
      remoteVideoEnabled: args.media === 'video',
      endCause: null,
    };
    this.emit();
    this.deps.send(CALL_EVENTS.invite, {
      callId,
      conversationId: args.conversationId,
      media: args.media,
    });
    return callId;
  }

  /** Answers the ringing incoming call with `stream` (from getUserMedia). */
  async accept(stream: MediaStream): Promise<void> {
    if (!this.snap || this.snap.phase !== 'incoming') {
      stopStream(stream);
      return;
    }
    this.polite = true;
    this.iceServers = this.fetchIceServers();
    this.update({
      phase: 'connecting',
      localStream: stream,
      audioEnabled: true,
      videoEnabled: stream.getVideoTracks().length > 0,
    });
    this.deps.send(CALL_EVENTS.accept, { callId: this.snap.callId });
    await this.startPeer();
  }

  decline(): void {
    if (!this.snap || this.snap.phase !== 'incoming') return;
    this.deps.send(CALL_EVENTS.decline, { callId: this.snap.callId });
    this.finish('declined');
  }

  /** Hangs up whatever state the call is in. */
  hangUp(): void {
    const snap = this.snap;
    if (!snap || snap.phase === 'ended') return;
    if (snap.phase === 'incoming') return this.decline();
    if (snap.phase === 'outgoing') {
      this.deps.send(CALL_EVENTS.cancel, { callId: snap.callId });
      return this.finish('cancelled');
    }
    this.deps.send(CALL_EVENTS.end, { callId: snap.callId });
    this.finish('completed');
  }

  /** Clears an ended call from view. */
  dismiss(): void {
    if (this.snap?.phase !== 'ended') return;
    this.snap = null;
    this.emit();
  }

  toggleAudio(): void {
    const snap = this.snap;
    if (!snap?.localStream) return;
    const enabled = !snap.audioEnabled;
    for (const track of snap.localStream.getAudioTracks()) track.enabled = enabled;
    this.update({ audioEnabled: enabled });
    this.sendMediaState();
  }

  /** Camera on/off. Turning it on in an audio-only call acquires a camera and renegotiates. */
  async toggleVideo(constraints: MediaTrackConstraints | boolean = true): Promise<void> {
    const snap = this.snap;
    if (!snap?.localStream || snap.phase === 'ended') return;
    const existing = snap.localStream.getVideoTracks()[0];
    if (existing) {
      existing.enabled = !snap.videoEnabled;
      this.update({ videoEnabled: existing.enabled });
    } else {
      const camera = await this.deps.getUserMedia({ video: constraints, audio: false });
      const track = camera.getVideoTracks()[0];
      if (!track || !this.snap || this.snap.phase === 'ended') {
        stopStream(camera);
        return;
      }
      snap.localStream.addTrack(track);
      // Triggers `negotiationneeded`, which sends a fresh offer to the other side.
      this.pc?.addTrack(track, snap.localStream);
      this.update({ videoEnabled: true });
    }
    this.sendMediaState();
  }

  /** Switches the microphone or camera mid-call without renegotiating (replaceTrack). */
  async switchDevice(kind: 'audioinput' | 'videoinput', deviceId: string): Promise<void> {
    const snap = this.snap;
    if (!snap?.localStream) return;
    const isAudio = kind === 'audioinput';
    const fresh = await this.deps.getUserMedia(
      isAudio
        ? { audio: { deviceId: { exact: deviceId } }, video: false }
        : { video: { deviceId: { exact: deviceId } }, audio: false },
    );
    const next = (isAudio ? fresh.getAudioTracks() : fresh.getVideoTracks())[0];
    if (!next) return;
    const current = (
      isAudio ? snap.localStream.getAudioTracks() : snap.localStream.getVideoTracks()
    )[0];
    next.enabled = isAudio ? snap.audioEnabled : snap.videoEnabled;
    const sender = this.pc?.getSenders().find((s) => s.track?.kind === next.kind);
    if (sender) await sender.replaceTrack(next);
    else this.pc?.addTrack(next, snap.localStream);
    if (current) {
      snap.localStream.removeTrack(current);
      current.stop();
    }
    snap.localStream.addTrack(next);
    this.update({});
  }

  /** Feeds a realtime envelope in. Anything not about this device's call is ignored. */
  handleEvent(envelope: WsEnvelope): void {
    switch (envelope.type) {
      case CALL_EVENTS.incoming:
        return this.onIncoming(envelope.payload);
      case CALL_EVENTS.ringing: {
        const ref = callRefSchema.safeParse(envelope.payload);
        if (ref.success && this.isCurrent(ref.data.callId) && this.snap?.phase === 'outgoing') {
          this.update({ calleeRinging: true });
        }
        return;
      }
      case CALL_EVENTS.accepted:
        return this.onAccepted(envelope.payload);
      case CALL_EVENTS.ended: {
        const ended = callEndedSchema.safeParse(envelope.payload);
        if (ended.success && this.isCurrent(ended.data.callId)) this.finish(ended.data.reason);
        return;
      }
      case CALL_EVENTS.offer:
      case CALL_EVENTS.answer:
      case CALL_EVENTS.ice:
        return this.onSignal(envelope);
      case CALL_EVENTS.media: {
        const media = callMediaStateSchema.safeParse(envelope.payload);
        if (media.success && this.isCurrent(media.data.callId)) {
          this.update({
            remoteAudioEnabled: media.data.audio,
            remoteVideoEnabled: media.data.video,
          });
        }
        return;
      }
      default:
        return;
    }
  }

  // --- internals ---------------------------------------------------------------------------

  private onIncoming(payload: unknown): void {
    const incoming = callIncomingSchema.safeParse(payload);
    if (!incoming.success) return;
    // Already in a call on this device: leave it to the server (which reports "busy") and to
    // whichever other device is free.
    if (this.isBusy()) return;
    this.reset();
    const { callId, conversationId, media, caller } = incoming.data;
    this.snap = {
      callId,
      conversationId,
      peer: caller,
      media,
      direction: 'incoming',
      phase: 'incoming',
      calleeRinging: false,
      startedAt: null,
      localStream: null,
      remoteStream: this.deps.createMediaStream(),
      audioEnabled: true,
      videoEnabled: false,
      remoteAudioEnabled: true,
      remoteVideoEnabled: media === 'video',
      endCause: null,
    };
    this.emit();
    this.deps.send(CALL_EVENTS.ringing, { callId });
  }

  private onAccepted(payload: unknown): void {
    const accepted = callAcceptedSchema.safeParse(payload);
    if (!accepted.success || !this.isCurrent(accepted.data.callId)) return;
    const snap = this.snap!;
    if (snap.direction === 'incoming') {
      // Someone answered -- if it wasn't this device, stop ringing here.
      if (accepted.data.connectionId !== this.deps.getConnectionId()) {
        this.finish('answered-elsewhere');
      }
      return;
    }
    if (snap.phase === 'outgoing') {
      this.update({ phase: 'connecting' });
      void this.startPeer();
    }
  }

  private onSignal(envelope: WsEnvelope): void {
    const callId = (envelope.payload as { callId?: unknown } | null)?.callId;
    if (typeof callId !== 'string' || !this.isCurrent(callId)) return;
    if (!this.pc) {
      this.pendingSignals.push(envelope);
      return;
    }
    this.signalChain = this.signalChain
      .then(() => this.applySignal(envelope))
      .catch(() => undefined);
  }

  private async applySignal(envelope: WsEnvelope): Promise<void> {
    const pc = this.pc;
    if (!pc) return;
    if (envelope.type === CALL_EVENTS.ice) {
      const ice = callIceSchema.safeParse(envelope.payload);
      if (!ice.success) return;
      try {
        await pc.addIceCandidate(ice.data.candidate);
      } catch (err) {
        // Candidates for an offer we deliberately ignored (perfect negotiation) are expected to fail.
        if (!this.ignoreOffer) throw err;
      }
      return;
    }
    const sdp = callSdpSchema.safeParse(envelope.payload);
    if (!sdp.success) return;
    const type: RTCSdpType = envelope.type === CALL_EVENTS.offer ? 'offer' : 'answer';
    const collision = type === 'offer' && (this.makingOffer || pc.signalingState !== 'stable');
    this.ignoreOffer = !this.polite && collision;
    if (this.ignoreOffer) return;
    await pc.setRemoteDescription({ type, sdp: sdp.data.sdp });
    if (type === 'offer') {
      await pc.setLocalDescription();
      this.sendDescription(pc);
    }
  }

  private async startPeer(): Promise<void> {
    const iceServers = await (this.iceServers ?? this.fetchIceServers());
    const snap = this.snap;
    if (!snap || snap.phase === 'ended' || this.pc) return;
    const pc = this.deps.createPeerConnection({ iceServers });
    this.pc = pc;

    pc.ontrack = (event) => {
      this.snap?.remoteStream?.addTrack(event.track);
      this.update({});
    };
    pc.onicecandidate = (event) => {
      if (event.candidate && this.snap) {
        this.deps.send(CALL_EVENTS.ice, {
          callId: this.snap.callId,
          candidate: event.candidate.toJSON(),
        });
      }
    };
    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await pc.setLocalDescription();
        this.sendDescription(pc);
      } catch {
        // A failed renegotiation attempt is retried by the next `negotiationneeded`.
      } finally {
        this.makingOffer = false;
      }
    };
    pc.onconnectionstatechange = () => this.onConnectionState(pc.connectionState);

    for (const track of snap.localStream?.getTracks() ?? []) {
      pc.addTrack(track, snap.localStream!);
    }

    const queued = this.pendingSignals;
    this.pendingSignals = [];
    for (const envelope of queued) this.onSignal(envelope);
  }

  protected onConnectionState(state: RTCPeerConnectionState): void {
    const snap = this.snap;
    if (!snap || snap.phase === 'ended') return;
    if (state === 'connected') {
      this.update({ phase: 'active', startedAt: snap.startedAt ?? this.deps.now() });
      this.sendMediaState();
    } else if (state === 'failed') {
      this.deps.send(CALL_EVENTS.end, { callId: snap.callId });
      this.finish('failed');
    }
  }

  private sendDescription(pc: RTCPeerConnection): void {
    const desc = pc.localDescription;
    if (!desc || !this.snap) return;
    this.deps.send(desc.type === 'offer' ? CALL_EVENTS.offer : CALL_EVENTS.answer, {
      callId: this.snap.callId,
      sdp: desc.sdp,
    });
  }

  private sendMediaState(): void {
    const snap = this.snap;
    if (!snap || !this.pc) return;
    this.deps.send(CALL_EVENTS.media, {
      callId: snap.callId,
      audio: snap.audioEnabled,
      video: snap.videoEnabled,
    });
  }

  private finish(cause: CallEndCause): void {
    if (!this.snap || this.snap.phase === 'ended') return;
    this.pc?.close();
    this.pc = null;
    stopStream(this.snap.localStream);
    this.update({ phase: 'ended', endCause: cause });
  }

  private reset(): void {
    this.pc?.close();
    this.pc = null;
    this.pendingSignals = [];
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.signalChain = Promise.resolve();
  }

  private fetchIceServers(): Promise<IceServer[]> {
    // No ICE servers is still a working call on the same network, so a failure isn't fatal.
    return this.deps.getIceServers().catch(() => []);
  }

  private isCurrent(callId: string): boolean {
    return this.snap !== null && this.snap.phase !== 'ended' && this.snap.callId === callId;
  }

  protected update(patch: Partial<CallSnapshot>): void {
    if (!this.snap) return;
    this.snap = { ...this.snap, ...patch };
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

function stopStream(stream: MediaStream | null | undefined): void {
  for (const track of stream?.getTracks() ?? []) track.stop();
}
