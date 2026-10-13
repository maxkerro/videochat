import { describe, expect, it, vi } from 'vitest';
import {
  CallBridge,
  incomingInfoOf,
  nativeEndReason,
  type NativeCallApi,
  type NativeHandlers,
  type NativeSession,
} from './callBridge';
import type { CallSnapshot, IncomingCallInfo } from './CallEngine';

const CALL = '11111111-1111-4111-8111-111111111111';
const CONV = '22222222-2222-4222-8222-222222222222';
const PEER = { id: 'ben', displayName: 'Ben', avatarUrl: null };
const flush = () => new Promise((r) => setTimeout(r, 0));

function snapshot(patch: Partial<CallSnapshot> = {}): CallSnapshot {
  return {
    callId: CALL,
    conversationId: CONV,
    peer: PEER,
    media: 'audio',
    direction: 'incoming',
    phase: 'incoming',
    calleeRinging: false,
    startedAt: null,
    localStream: null,
    remoteStream: null,
    frontCamera: true,
    audioEnabled: true,
    videoEnabled: false,
    videoPaused: false,
    remoteAudioEnabled: true,
    remoteVideoEnabled: false,
    endCause: null,
    endedAt: null,
    quality: 'unknown',
    lowBandwidth: false,
    ...patch,
  } as CallSnapshot;
}

function pushSession(over: Partial<NativeSession> = {}): NativeSession {
  return {
    id: 'os-1',
    origin: 'incoming',
    status: 'ringing',
    incomingCallEvent: {
      eventId: CALL,
      serverCallId: CALL,
      hasVideo: false,
      startedAt: new Date(1_000).toISOString(),
      caller: { id: 'ben', displayName: 'Ben' },
      metadata: { conversationId: CONV },
    },
    ...over,
  };
}

function setUp(opts: { active?: NativeSession | null; now?: () => number } = {}) {
  let handlers!: NativeHandlers;
  const api = {
    reportIncoming: vi.fn().mockResolvedValue(undefined),
    startOutgoing: vi.fn().mockResolvedValue('os-out'),
    reportOutgoingConnected: vi.fn().mockResolvedValue(undefined),
    answer: vi.fn().mockResolvedValue(undefined),
    fulfillAnswered: vi.fn().mockResolvedValue(undefined),
    failAnswered: vi.fn().mockResolvedValue(undefined),
    reportEnded: vi.fn().mockResolvedValue(undefined),
    end: vi.fn().mockResolvedValue(undefined),
    setMuted: vi.fn().mockResolvedValue(undefined),
    activeSession: vi.fn().mockResolvedValue(opts.active ?? null),
    listen: vi.fn((h: NativeHandlers) => {
      handlers = h;
      return () => undefined;
    }),
  };
  let snap: CallSnapshot | null = null;
  const engine = {
    getSnapshot: () => snap,
    presentIncoming: vi.fn((info: IncomingCallInfo) => {
      snap = snapshot({ callId: info.callId, media: info.media, peer: info.caller });
      return true;
    }),
    decline: vi.fn(),
    hangUp: vi.fn(),
    abandonIncoming: vi.fn(),
    setAudioEnabled: vi.fn(),
  };
  let clock = 1_000;
  const accept = vi.fn().mockResolvedValue(true);
  const waitForSignalling = vi.fn().mockResolvedValue(true);
  const bridge = new CallBridge({
    api: api as unknown as NativeCallApi,
    engine,
    waitForSignalling,
    now: opts.now ?? (() => clock),
  });
  bridge.setAnswerer(accept);
  return {
    api,
    engine,
    bridge,
    accept,
    waitForSignalling,
    handlers: () => handlers,
    set: (next: CallSnapshot | null) => {
      snap = next;
      bridge.onSnapshot(next);
    },
    tick: (ms: number) => (clock += ms),
  };
}

describe('nativeEndReason', () => {
  it('words how the other side or the server ended the call', () => {
    expect(nativeEndReason('answered-elsewhere')).toBe('answeredElsewhere');
    expect(nativeEndReason('missed')).toBe('unanswered');
    expect(nativeEndReason('failed')).toBe('failed');
    expect(nativeEndReason('connection-lost')).toBe('failed');
    expect(nativeEndReason('cancelled')).toBe('remoteEnded');
    expect(nativeEndReason('completed')).toBe('remoteEnded');
    expect(nativeEndReason(null)).toBe('unknown');
  });
});

describe('incomingInfoOf', () => {
  it('needs the conversation, which the push carries as metadata', () => {
    expect(incomingInfoOf(pushSession())).toEqual({
      callId: CALL,
      conversationId: CONV,
      media: 'audio',
      caller: { id: 'ben', displayName: 'Ben', avatarUrl: null },
    });
    const noMeta = pushSession();
    delete noMeta.incomingCallEvent!.metadata;
    expect(incomingInfoOf(noMeta)).toBeNull();
    expect(incomingInfoOf(undefined)).toBeNull();
  });
});

describe('CallBridge: incoming', () => {
  it('reports a call that arrived over the socket to the system, with its conversation', async () => {
    const t = setUp();
    await t.bridge.start();
    t.set(snapshot({ media: 'video' }));
    await flush();
    expect(t.api.reportIncoming).toHaveBeenCalledOnce();
    expect(t.api.reportIncoming.mock.calls[0]![0]).toMatchObject({
      eventId: CALL,
      serverCallId: CALL,
      hasVideo: true,
      caller: { id: 'ben', displayName: 'Ben' },
      metadata: { conversationId: CONV },
    });
  });

  it('adopts the system call a push already reported, and reports nothing twice', async () => {
    const t = setUp();
    await t.bridge.start();
    t.api.reportIncoming.mockRejectedValue(new Error('another session exists'));
    t.api.activeSession.mockResolvedValue(pushSession());
    t.set(snapshot());
    await flush();
    t.set(snapshot({ startedAt: 5, phase: 'active' }));
    // answering through the app's own screen reaches the system call
    expect(t.bridge.requestAnswer()).toBe(false); // active now, not ringing
    t.set(snapshot());
    expect(t.bridge.requestAnswer()).toBe(true);
    expect(t.api.answer).toHaveBeenCalledWith('os-1');
  });

  it('answering on the system screen accepts, then confirms once media is connected', async () => {
    const t = setUp();
    await t.bridge.start();
    t.handlers().sessionAdded(pushSession());
    t.set(snapshot());
    await flush();
    t.handlers().answered({ id: 'os-1', requestId: 'req-1' });
    await flush();
    expect(t.accept).toHaveBeenCalledWith('audio');
    expect(t.api.fulfillAnswered).not.toHaveBeenCalled();

    t.set(snapshot({ phase: 'active', startedAt: 9 }));
    t.set(snapshot({ phase: 'active', startedAt: 9 }));
    expect(t.api.fulfillAnswered).toHaveBeenCalledOnce();
    expect(t.api.fulfillAnswered).toHaveBeenCalledWith('req-1');
  });

  it('shows the call and answers it when the app was started by the answer', async () => {
    const t = setUp();
    await t.bridge.start();
    t.handlers().sessionAdded(pushSession());
    t.handlers().answered({ id: 'os-1', requestId: 'req-1' });
    await flush();
    expect(t.engine.presentIncoming).toHaveBeenCalledOnce();
    expect(t.accept).toHaveBeenCalledWith('audio');
  });

  it('fails the system answer when the call cannot be answered', async () => {
    const t = setUp();
    await t.bridge.start();
    t.accept.mockResolvedValue(false);
    t.handlers().sessionAdded(pushSession());
    t.handlers().answered({ id: 'os-1', requestId: 'req-1' });
    await flush();
    expect(t.api.failAnswered).toHaveBeenCalledWith('os-1', 'req-1');
    expect(t.engine.decline).toHaveBeenCalled();
  });

  it('refuses an answer for a call it does not know', async () => {
    const t = setUp();
    await t.bridge.start();
    t.handlers().answered({ id: 'ghost', requestId: 'req-9' });
    await flush();
    expect(t.api.failAnswered).toHaveBeenCalledWith('ghost', 'req-9');
    expect(t.accept).not.toHaveBeenCalled();
  });

  it('declining on the system screen declines the call', async () => {
    const t = setUp();
    await t.bridge.start();
    t.handlers().sessionAdded(pushSession());
    t.set(snapshot());
    await flush();
    t.tick(3_000);
    t.handlers().ended({ id: 'os-1' });
    await flush();
    expect(t.engine.decline).toHaveBeenCalledOnce();
    expect(t.engine.abandonIncoming).not.toHaveBeenCalled();
  });

  it('treats a ring that ran out as missed, not declined', async () => {
    const t = setUp();
    await t.bridge.start();
    t.handlers().sessionAdded(pushSession());
    t.set(snapshot());
    await flush();
    t.tick(29_000);
    t.handlers().ended({ id: 'os-1' });
    await flush();
    expect(t.engine.abandonIncoming).toHaveBeenCalledOnce();
    expect(t.engine.decline).not.toHaveBeenCalled();
  });

  it('hangs up when the person ends an answered call from the system screen', async () => {
    const t = setUp();
    await t.bridge.start();
    t.handlers().sessionAdded(pushSession());
    t.set(snapshot({ phase: 'active', startedAt: 5 }));
    await flush();
    t.handlers().ended({ id: 'os-1' });
    await flush();
    expect(t.engine.hangUp).toHaveBeenCalledOnce();
  });

  it('declines on the server when the person declined before the app was running', async () => {
    const t = setUp();
    await t.bridge.start();
    t.handlers().ended({ id: 'os-1', session: pushSession() });
    await flush();
    expect(t.waitForSignalling).toHaveBeenCalled();
    expect(t.engine.presentIncoming).toHaveBeenCalledOnce();
    expect(t.engine.decline).toHaveBeenCalledOnce();
  });

  it('presents the call the system is ringing for when the app starts', async () => {
    const t = setUp({ active: pushSession() });
    await t.bridge.start();
    expect(t.engine.presentIncoming).toHaveBeenCalledOnce();
  });

  it('ends the system call with the right reason when the other side ends the call', async () => {
    const t = setUp();
    await t.bridge.start();
    t.handlers().sessionAdded(pushSession());
    t.set(snapshot());
    await flush();
    t.set(snapshot({ phase: 'ended', endCause: 'cancelled' }));
    await flush();
    expect(t.api.reportEnded).toHaveBeenCalledWith('os-1', 'remoteEnded');
    expect(t.api.end).not.toHaveBeenCalled();
  });

  it('ends it as "ended by me" when this phone ended the call', async () => {
    const t = setUp();
    await t.bridge.start();
    t.handlers().sessionAdded(pushSession());
    t.set(snapshot());
    await flush();
    t.bridge.noteLocalEnd();
    t.set(snapshot({ phase: 'ended', endCause: 'declined' }));
    await flush();
    expect(t.api.end).toHaveBeenCalledWith('os-1');
    expect(t.api.reportEnded).not.toHaveBeenCalled();
  });

  it('cancels a pending system answer when the call dies before connecting', async () => {
    const t = setUp();
    await t.bridge.start();
    t.handlers().sessionAdded(pushSession());
    t.set(snapshot());
    t.handlers().answered({ id: 'os-1', requestId: 'req-1' });
    await flush();
    t.set(snapshot({ phase: 'ended', endCause: 'cancelled' }));
    await flush();
    expect(t.api.failAnswered).toHaveBeenCalledWith('os-1', 'req-1');
  });

  it('ends the call on another device as "answered elsewhere"', async () => {
    const t = setUp();
    await t.bridge.start();
    t.handlers().sessionAdded(pushSession());
    t.set(snapshot());
    await flush();
    t.set(snapshot({ phase: 'ended', endCause: 'answered-elsewhere' }));
    await flush();
    expect(t.api.reportEnded).toHaveBeenCalledWith('os-1', 'answeredElsewhere');
  });
});

describe('CallBridge: outgoing and mute', () => {
  const outgoing = (patch: Partial<CallSnapshot> = {}) =>
    snapshot({ direction: 'outgoing', phase: 'outgoing', ...patch });

  it('registers an outgoing call, and reports it connected once', async () => {
    const t = setUp();
    await t.bridge.start();
    t.set(outgoing({ media: 'video' }));
    await flush();
    expect(t.api.startOutgoing).toHaveBeenCalledWith(PEER, true);
    t.set(outgoing({ phase: 'active', startedAt: 5 }));
    t.set(outgoing({ phase: 'active', startedAt: 5 }));
    expect(t.api.reportOutgoingConnected).toHaveBeenCalledOnce();
    expect(t.api.reportOutgoingConnected).toHaveBeenCalledWith('os-out');
  });

  it('carries on without the system when it refuses the call', async () => {
    const t = setUp();
    await t.bridge.start();
    t.api.startOutgoing.mockRejectedValue(new Error('no'));
    t.set(outgoing());
    await flush();
    t.set(outgoing({ phase: 'active', startedAt: 5 }));
    expect(t.api.reportOutgoingConnected).not.toHaveBeenCalled();
  });

  it('ends a call that finished while the system was still setting it up', async () => {
    const t = setUp();
    await t.bridge.start();
    let resolve!: (id: string) => void;
    t.api.startOutgoing.mockReturnValue(new Promise<string>((r) => (resolve = r)));
    t.set(outgoing());
    t.set(null);
    resolve('os-out');
    await flush();
    expect(t.api.end).toHaveBeenCalledWith('os-out');
  });

  it('keeps mute in step both ways without echoing', async () => {
    const t = setUp();
    await t.bridge.start();
    t.set(outgoing({ localStream: {} as never }));
    await flush();
    expect(t.api.setMuted).not.toHaveBeenCalled();

    t.set(outgoing({ localStream: {} as never, audioEnabled: false }));
    expect(t.api.setMuted).toHaveBeenCalledWith('os-out', true);

    t.handlers().muted({ id: 'os-out', isMuted: false });
    expect(t.engine.setAudioEnabled).toHaveBeenCalledWith(true);
    t.set(outgoing({ localStream: {} as never, audioEnabled: true }));
    expect(t.api.setMuted).toHaveBeenCalledTimes(1);
  });
});
