import { CALL_EVENTS, makeEnvelope } from '@videochat/shared';
import { CallBusyError, CallEngine, type CallEngineDeps } from './CallEngine';

class FakeTrack {
  enabled = true;
  stopped = false;
  constructor(readonly kind: 'audio' | 'video') {}
  stop() {
    this.stopped = true;
  }
}

class FakeStream {
  tracks: FakeTrack[];
  constructor(tracks: FakeTrack[] = []) {
    this.tracks = tracks;
  }
  getTracks() {
    return [...this.tracks];
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === 'audio');
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === 'video');
  }
  addTrack(t: FakeTrack) {
    this.tracks.push(t);
  }
  removeTrack(t: FakeTrack) {
    this.tracks = this.tracks.filter((x) => x !== t);
  }
}

/** Models just enough of RTCPeerConnection's signalling state machine for perfect negotiation. */
class FakePeerConnection {
  signalingState: RTCSignalingState = 'stable';
  connectionState: RTCPeerConnectionState = 'new';
  localDescription: { type: RTCSdpType; sdp: string } | null = null;
  remoteDescriptions: { type: RTCSdpType; sdp: string }[] = [];
  candidates: unknown[] = [];
  senders: { track: FakeTrack; replaceTrack: (t: FakeTrack) => Promise<void> }[] = [];
  closed = false;
  restarted = 0;
  statsReport: Record<string, unknown>[] = [];
  ontrack: ((e: { track: FakeTrack }) => void) | null = null;
  onicecandidate: ((e: { candidate: { toJSON(): unknown } | null }) => void) | null = null;
  onnegotiationneeded: (() => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  private negotiationQueued = false;

  constructor(readonly config: RTCConfiguration) {}

  addTrack(track: FakeTrack) {
    const sender = {
      track,
      replaceTrack: async (t: FakeTrack) => {
        sender.track = t;
      },
    };
    this.senders.push(sender);
    if (!this.negotiationQueued) {
      this.negotiationQueued = true;
      queueMicrotask(() => {
        this.negotiationQueued = false;
        this.onnegotiationneeded?.();
      });
    }
  }
  getSenders() {
    return this.senders;
  }
  async setLocalDescription() {
    if (this.signalingState === 'have-remote-offer') {
      this.localDescription = { type: 'answer', sdp: 'answer-sdp' };
      this.signalingState = 'stable';
    } else {
      this.localDescription = { type: 'offer', sdp: 'offer-sdp' };
      this.signalingState = 'have-local-offer';
    }
  }
  async setRemoteDescription(desc: { type: RTCSdpType; sdp: string }) {
    this.remoteDescriptions.push(desc);
    this.signalingState = desc.type === 'offer' ? 'have-remote-offer' : 'stable';
  }
  async addIceCandidate(c: unknown) {
    this.candidates.push(c);
  }
  restartIce() {
    this.restarted += 1;
  }
  close() {
    this.closed = true;
  }
  async getStats() {
    const stats = this.statsReport;
    return { forEach: (cb: (s: Record<string, unknown>) => void) => stats.forEach(cb) };
  }
  setConnectionState(state: RTCPeerConnectionState) {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
}

const CALL_ID = '11111111-1111-4111-8111-111111111111';
const CONV_ID = '22222222-2222-4222-8222-222222222222';
const PEER = { id: '33333333-3333-4333-8333-333333333333', displayName: 'Ben', avatarUrl: null };

function setUp(overrides: Partial<CallEngineDeps> = {}) {
  const sent: { type: string; payload: Record<string, unknown> }[] = [];
  const pcs: FakePeerConnection[] = [];
  const deps: CallEngineDeps = {
    send: (type, payload) => sent.push({ type, payload: payload as Record<string, unknown> }),
    getConnectionId: () => 'my-conn',
    getIceServers: async () => [{ urls: 'stun:stun.test' }],
    getUserMedia: async () => new FakeStream([new FakeTrack('video')]) as unknown as MediaStream,
    createPeerConnection: (config) => {
      const pc = new FakePeerConnection(config);
      pcs.push(pc);
      return pc as unknown as RTCPeerConnection;
    },
    createMediaStream: () => new FakeStream() as unknown as MediaStream,
    now: () => 1_000,
    newCallId: () => CALL_ID,
    reportStats: vi.fn(),
    ...overrides,
  };
  const engine = new CallEngine(deps);
  const event = (type: string, payload: unknown) =>
    engine.handleEvent(makeEnvelope(type, payload, `e-${Math.random()}`));
  const lastSent = (type: string) => [...sent].reverse().find((m) => m.type === type);
  return { engine, sent, pcs, event, lastSent };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const avStream = () =>
  new FakeStream([new FakeTrack('audio'), new FakeTrack('video')]) as unknown as MediaStream;
const audioStream = () => new FakeStream([new FakeTrack('audio')]) as unknown as MediaStream;

describe('CallEngine (CHAT-042)', () => {
  describe('placing a call', () => {
    it('sends an invite and shows "calling", then "ringing" once a callee device rings', () => {
      const { engine, sent, event } = setUp();
      engine.startOutgoing({
        conversationId: CONV_ID,
        peer: PEER,
        media: 'video',
        stream: avStream(),
      });

      expect(sent[0]).toEqual({
        type: CALL_EVENTS.invite,
        payload: { callId: CALL_ID, conversationId: CONV_ID, media: 'video' },
      });
      expect(engine.getSnapshot()).toMatchObject({ phase: 'outgoing', calleeRinging: false });

      event(CALL_EVENTS.ringing, { callId: CALL_ID });
      expect(engine.getSnapshot()?.calleeRinging).toBe(true);
    });

    it('refuses to place a second call while one is in progress', () => {
      const { engine } = setUp();
      engine.startOutgoing({
        conversationId: CONV_ID,
        peer: PEER,
        media: 'audio',
        stream: audioStream(),
      });
      expect(() =>
        engine.startOutgoing({
          conversationId: CONV_ID,
          peer: PEER,
          media: 'audio',
          stream: audioStream(),
        }),
      ).toThrow(CallBusyError);
    });

    it('on answer, connects with the fetched ICE servers and sends an offer', async () => {
      const { engine, pcs, event, lastSent } = setUp();
      engine.startOutgoing({
        conversationId: CONV_ID,
        peer: PEER,
        media: 'video',
        stream: avStream(),
      });

      event(CALL_EVENTS.accepted, { callId: CALL_ID, connectionId: 'their-conn' });
      expect(engine.getSnapshot()?.phase).toBe('connecting');
      await flush();

      expect(pcs).toHaveLength(1);
      expect(pcs[0]!.config.iceServers).toEqual([{ urls: 'stun:stun.test' }]);
      expect(pcs[0]!.senders.map((s) => s.track.kind)).toEqual(['audio', 'video']);
      expect(lastSent(CALL_EVENTS.offer)?.payload).toEqual({ callId: CALL_ID, sdp: 'offer-sdp' });

      event(CALL_EVENTS.answer, { callId: CALL_ID, sdp: 'remote-answer' });
      await flush();
      expect(pcs[0]!.remoteDescriptions).toEqual([{ type: 'answer', sdp: 'remote-answer' }]);
    });

    it('goes live (timer starts, media state sent) once the connection is up', async () => {
      const { engine, pcs, event, lastSent } = setUp();
      engine.startOutgoing({
        conversationId: CONV_ID,
        peer: PEER,
        media: 'video',
        stream: avStream(),
      });
      event(CALL_EVENTS.accepted, { callId: CALL_ID, connectionId: 'their-conn' });
      await flush();

      pcs[0]!.setConnectionState('connected');

      expect(engine.getSnapshot()).toMatchObject({ phase: 'active', startedAt: 1_000 });
      expect(lastSent(CALL_EVENTS.media)?.payload).toEqual({
        callId: CALL_ID,
        audio: true,
        video: true,
      });
    });

    it('cancels (not "ends") when hanging up before it is answered', () => {
      const { engine, lastSent } = setUp();
      const stream = avStream();
      engine.startOutgoing({ conversationId: CONV_ID, peer: PEER, media: 'video', stream });

      engine.hangUp();

      expect(lastSent(CALL_EVENTS.cancel)?.payload).toEqual({ callId: CALL_ID });
      expect(engine.getSnapshot()).toMatchObject({ phase: 'ended', endCause: 'cancelled' });
      expect(stream.getTracks().every((t) => (t as unknown as FakeTrack).stopped)).toBe(true);
    });
  });

  describe('receiving a call', () => {
    const incoming = {
      callId: CALL_ID,
      conversationId: CONV_ID,
      media: 'video',
      caller: PEER,
    };

    it('rings and tells the caller it is ringing', () => {
      const { engine, event, lastSent } = setUp();
      event(CALL_EVENTS.incoming, incoming);
      expect(engine.getSnapshot()).toMatchObject({
        phase: 'incoming',
        direction: 'incoming',
        peer: PEER,
      });
      expect(lastSent(CALL_EVENTS.ringing)?.payload).toEqual({ callId: CALL_ID });
    });

    it("answering sends accept and replies to the caller's offer with an answer", async () => {
      const { engine, pcs, event, lastSent } = setUp();
      event(CALL_EVENTS.incoming, incoming);

      await engine.accept(avStream());
      expect(lastSent(CALL_EVENTS.accept)?.payload).toEqual({ callId: CALL_ID });

      event(CALL_EVENTS.offer, { callId: CALL_ID, sdp: 'remote-offer' });
      await flush();
      await flush();
      expect(pcs[0]!.remoteDescriptions[0]).toEqual({ type: 'offer', sdp: 'remote-offer' });
      expect(lastSent(CALL_EVENTS.answer)?.payload).toEqual({ callId: CALL_ID, sdp: 'answer-sdp' });
    });

    it('stops ringing when another of my devices answers ("answered elsewhere")', () => {
      const { engine, event } = setUp();
      event(CALL_EVENTS.incoming, incoming);
      event(CALL_EVENTS.accepted, { callId: CALL_ID, connectionId: 'my-other-tab' });
      expect(engine.getSnapshot()).toMatchObject({
        phase: 'ended',
        endCause: 'answered-elsewhere',
      });
    });

    it("keeps the call when the answer was this device's own", async () => {
      const { engine, event } = setUp();
      event(CALL_EVENTS.incoming, incoming);
      await engine.accept(avStream());
      event(CALL_EVENTS.accepted, { callId: CALL_ID, connectionId: 'my-conn' });
      expect(engine.getSnapshot()?.phase).toBe('connecting');
    });

    it('declining tells the server and ends locally', () => {
      const { engine, event, lastSent } = setUp();
      event(CALL_EVENTS.incoming, incoming);
      engine.decline();
      expect(lastSent(CALL_EVENTS.decline)?.payload).toEqual({ callId: CALL_ID });
      expect(engine.getSnapshot()?.endCause).toBe('declined');
    });

    it('ignores a second incoming call while already in one', () => {
      const { engine, event } = setUp();
      engine.startOutgoing({
        conversationId: CONV_ID,
        peer: PEER,
        media: 'audio',
        stream: audioStream(),
      });
      event(CALL_EVENTS.incoming, { ...incoming, callId: '44444444-4444-4444-8444-444444444444' });
      expect(engine.getSnapshot()?.callId).toBe(CALL_ID);
    });

    it('queues negotiation that arrives before the connection exists, then applies it', async () => {
      let releaseIce!: () => void;
      const iceReady = new Promise<void>((r) => (releaseIce = r));
      const { engine, pcs, event, lastSent } = setUp({
        getIceServers: () => iceReady.then(() => []),
      });
      event(CALL_EVENTS.incoming, incoming);
      const accepting = engine.accept(avStream());

      event(CALL_EVENTS.offer, { callId: CALL_ID, sdp: 'early-offer' });
      expect(pcs).toHaveLength(0);

      releaseIce();
      await accepting;
      await flush();
      await flush();
      expect(pcs[0]!.remoteDescriptions[0]).toEqual({ type: 'offer', sdp: 'early-offer' });
      expect(lastSent(CALL_EVENTS.answer)).toBeDefined();
    });
  });

  describe('during a call', () => {
    async function liveCall() {
      const ctx = setUp();
      const stream = avStream();
      ctx.engine.startOutgoing({ conversationId: CONV_ID, peer: PEER, media: 'video', stream });
      ctx.event(CALL_EVENTS.accepted, { callId: CALL_ID, connectionId: 'their-conn' });
      await flush();
      ctx.pcs[0]!.setConnectionState('connected');
      return { ...ctx, stream, pc: ctx.pcs[0]! };
    }

    it('mute disables the microphone track and tells the other side', async () => {
      const { engine, stream, lastSent } = await liveCall();
      engine.toggleAudio();
      expect((stream.getAudioTracks()[0] as unknown as FakeTrack).enabled).toBe(false);
      expect(engine.getSnapshot()?.audioEnabled).toBe(false);
      expect(lastSent(CALL_EVENTS.media)?.payload).toEqual({
        callId: CALL_ID,
        audio: false,
        video: true,
      });
    });

    it('camera off disables the video track and tells the other side', async () => {
      const { engine, stream, lastSent } = await liveCall();
      await engine.toggleVideo();
      expect((stream.getVideoTracks()[0] as unknown as FakeTrack).enabled).toBe(false);
      expect(lastSent(CALL_EVENTS.media)?.payload).toEqual({
        callId: CALL_ID,
        audio: true,
        video: false,
      });
    });

    it("shows the other side's mute/camera state", async () => {
      const { engine, event } = await liveCall();
      event(CALL_EVENTS.media, { callId: CALL_ID, audio: false, video: false });
      expect(engine.getSnapshot()).toMatchObject({
        remoteAudioEnabled: false,
        remoteVideoEnabled: false,
      });
    });

    it('turning the camera on in an audio call acquires it and renegotiates', async () => {
      const ctx = setUp();
      ctx.engine.startOutgoing({
        conversationId: CONV_ID,
        peer: PEER,
        media: 'audio',
        stream: audioStream(),
      });
      ctx.event(CALL_EVENTS.accepted, { callId: CALL_ID, connectionId: 'their-conn' });
      await flush();
      ctx.event(CALL_EVENTS.answer, { callId: CALL_ID, sdp: 'a1' });
      await flush();
      ctx.sent.length = 0;

      await ctx.engine.toggleVideo();
      await flush();

      expect(ctx.engine.getSnapshot()?.videoEnabled).toBe(true);
      expect(ctx.pcs[0]!.senders.map((s) => s.track.kind)).toContain('video');
      expect(ctx.lastSent(CALL_EVENTS.offer)).toBeDefined();
    });

    it('switching camera replaces the sent track without renegotiating', async () => {
      const { engine, pc, stream, sent } = await liveCall();
      const oldVideo = stream.getVideoTracks()[0] as unknown as FakeTrack;
      sent.length = 0;

      await engine.switchDevice('videoinput', 'cam-2');

      const sentVideo = pc.senders.find((s) => s.track.kind === 'video')!.track;
      expect(sentVideo).not.toBe(oldVideo);
      expect(oldVideo.stopped).toBe(true);
      expect(sent.find((m) => m.type === CALL_EVENTS.offer)).toBeUndefined();
    });

    it('relays local ICE candidates and applies remote ones', async () => {
      const { pc, event, lastSent } = await liveCall();
      pc.onicecandidate?.({ candidate: { toJSON: () => ({ candidate: 'c1', sdpMid: '0' }) } });
      expect(lastSent(CALL_EVENTS.ice)?.payload).toEqual({
        callId: CALL_ID,
        candidate: { candidate: 'c1', sdpMid: '0' },
      });

      event(CALL_EVENTS.ice, { callId: CALL_ID, candidate: { candidate: 'c2', sdpMid: '0' } });
      await flush();
      expect(pc.candidates).toEqual([{ candidate: 'c2', sdpMid: '0' }]);
    });

    it('as the impolite caller, ignores an offer that collides with its own', async () => {
      const { pc, event } = await liveCall();
      expect(pc.signalingState).toBe('have-local-offer'); // our offer is still unanswered
      event(CALL_EVENTS.offer, { callId: CALL_ID, sdp: 'colliding-offer' });
      await flush();
      expect(pc.remoteDescriptions).toEqual([]);
    });

    it('hanging up ends it, closes the connection and releases the camera/mic', async () => {
      const { engine, pc, stream, lastSent } = await liveCall();
      engine.hangUp();
      expect(lastSent(CALL_EVENTS.end)?.payload).toEqual({ callId: CALL_ID });
      expect(engine.getSnapshot()).toMatchObject({ phase: 'ended', endCause: 'completed' });
      expect(pc.closed).toBe(true);
      expect(stream.getTracks().every((t) => (t as unknown as FakeTrack).stopped)).toBe(true);
    });

    it('ends when the server says so, with its reason', async () => {
      const { engine, event, pc } = await liveCall();
      event(CALL_EVENTS.ended, { callId: CALL_ID, reason: 'completed' });
      expect(engine.getSnapshot()).toMatchObject({ phase: 'ended', endCause: 'completed' });
      expect(pc.closed).toBe(true);
      engine.dismiss();
      expect(engine.getSnapshot()).toBeNull();
    });

    it('ignores events for other calls', async () => {
      const { engine, event } = await liveCall();
      event(CALL_EVENTS.ended, {
        callId: '55555555-5555-4555-8555-555555555555',
        reason: 'completed',
      });
      expect(engine.getSnapshot()?.phase).toBe('active');
    });
  });

  describe('network resilience and quality (CHAT-043)', () => {
    afterEach(() => vi.useRealTimers());

    async function liveCall(asCallee = false) {
      const ctx = setUp();
      if (asCallee) {
        ctx.event(CALL_EVENTS.incoming, {
          callId: CALL_ID,
          conversationId: CONV_ID,
          media: 'video',
          caller: PEER,
        });
        await ctx.engine.accept(avStream());
      } else {
        ctx.engine.startOutgoing({
          conversationId: CONV_ID,
          peer: PEER,
          media: 'video',
          stream: avStream(),
        });
        ctx.event(CALL_EVENTS.accepted, { callId: CALL_ID, connectionId: 'their-conn' });
        await flush();
      }
      const pc = ctx.pcs[0]!;
      pc.setConnectionState('connected');
      return { ...ctx, pc };
    }

    it('shows "reconnecting" on a drop and restarts ICE if it has not recovered in 2 s', async () => {
      const { engine, pc } = await liveCall();
      vi.useFakeTimers();
      pc.setConnectionState('disconnected');
      expect(engine.getSnapshot()?.phase).toBe('reconnecting');
      expect(pc.restarted).toBe(0);
      vi.advanceTimersByTime(2_000);
      expect(pc.restarted).toBe(1);
    });

    it('restarts ICE immediately when the connection fails', async () => {
      const { engine, pc } = await liveCall();
      pc.setConnectionState('failed');
      expect(engine.getSnapshot()?.phase).toBe('reconnecting');
      expect(pc.restarted).toBe(1);
    });

    it('goes back to the live call when the connection recovers, keeping the timer', async () => {
      const { engine, pc } = await liveCall();
      vi.useFakeTimers();
      pc.setConnectionState('disconnected');
      pc.setConnectionState('connected');
      expect(engine.getSnapshot()).toMatchObject({ phase: 'active', startedAt: 1_000 });
      vi.advanceTimersByTime(20_000);
      expect(engine.getSnapshot()?.phase).toBe('active');
    });

    it('ends the call after 15 s of failing to reconnect', async () => {
      const { engine, pc, lastSent } = await liveCall();
      vi.useFakeTimers();
      pc.setConnectionState('disconnected');
      vi.advanceTimersByTime(14_999);
      expect(engine.getSnapshot()?.phase).toBe('reconnecting');
      vi.advanceTimersByTime(1);
      expect(engine.getSnapshot()).toMatchObject({ phase: 'ended', endCause: 'connection-lost' });
      expect(lastSent(CALL_EVENTS.end)?.payload).toEqual({ callId: CALL_ID });
    });

    it('re-attaches the call when the signalling socket reconnects', async () => {
      const { engine, lastSent } = await liveCall();
      engine.onSignallingReconnected();
      expect(lastSent(CALL_EVENTS.resume)?.payload).toEqual({ callId: CALL_ID });
    });

    it('does nothing on a socket reconnect when not in a call', () => {
      const { engine, sent } = setUp();
      engine.onSignallingReconnected();
      expect(sent).toEqual([]);
    });

    it('the caller restarts ICE when either side resumes; the callee waits for its offer', async () => {
      const caller = await liveCall();
      caller.event(CALL_EVENTS.resume, { callId: CALL_ID });
      expect(caller.pc.restarted).toBe(1);

      const callee = await liveCall(true);
      callee.event(CALL_EVENTS.resume, { callId: CALL_ID });
      expect(callee.pc.restarted).toBe(0);
    });

    it('restarts ICE straight away when the network changes (e.g. Wi-Fi -> tethering)', async () => {
      const { engine, pc } = await liveCall();
      engine.onNetworkChange();
      expect(pc.restarted).toBe(1);
    });

    it('flags a poor connection from getStats and suggests audio only on low bandwidth', async () => {
      // Only the stats interval is faked: it starts as soon as the call connects, inside liveCall().
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const { engine, pc } = await liveCall();
      pc.statsReport = [
        { type: 'inbound-rtp', packetsReceived: 900, packetsLost: 100 },
        {
          type: 'candidate-pair',
          nominated: true,
          state: 'succeeded',
          currentRoundTripTime: 0.05,
          availableOutgoingBitrate: 90_000,
        },
      ];
      await vi.advanceTimersByTimeAsync(2_000);
      expect(engine.getSnapshot()).toMatchObject({ quality: 'poor', lowBandwidth: true });
    });

    it('sends a quality summary when the call ends', async () => {
      // Only the stats interval is faked: it starts as soon as the call connects, inside liveCall().
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      const { engine, pc } = await liveCall();
      pc.statsReport = [
        { type: 'inbound-rtp', packetsReceived: 990, packetsLost: 10 },
        {
          type: 'candidate-pair',
          nominated: true,
          state: 'succeeded',
          currentRoundTripTime: 0.12,
          availableOutgoingBitrate: 900_000,
        },
      ];
      await vi.advanceTimersByTimeAsync(2_000);
      pc.setConnectionState('disconnected');
      pc.setConnectionState('connected');

      engine.hangUp();

      const report = vi.mocked(engine['deps'].reportStats!);
      expect(report).toHaveBeenCalledWith(CALL_ID, {
        durationSec: 0,
        rttMsAvg: 120,
        packetLossPctMax: 1,
        outgoingKbpsMin: 900,
        reconnects: 1,
        hadVideo: true,
        endCause: 'completed',
      });
    });

    it('sends no summary for a call that was never answered', () => {
      const { engine } = setUp();
      engine.startOutgoing({
        conversationId: CONV_ID,
        peer: PEER,
        media: 'audio',
        stream: audioStream(),
      });
      engine.hangUp();
      expect(engine['deps'].reportStats).not.toHaveBeenCalled();
    });
  });
});
