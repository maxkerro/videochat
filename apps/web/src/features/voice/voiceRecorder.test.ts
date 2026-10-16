import { VOICE } from '@videochat/shared';
import { MIN_VOICE_MS, pickRecordingMime, VoiceRecorder, type RecorderDeps } from './voiceRecorder';

class FakeRecorder {
  state: 'inactive' | 'recording' = 'inactive';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(readonly mimeType: string) {}
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['opus-bytes'], { type: this.mimeType }) });
    this.onstop?.();
  }
}

function setUp(supported = ['audio/webm;codecs=opus']) {
  let now = 1_000;
  const track = { stop: vi.fn() };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  const recorders: FakeRecorder[] = [];
  const meter = { level: vi.fn(() => 0.5), close: vi.fn() };
  const deps: RecorderDeps = {
    getUserMedia: vi.fn(() => Promise.resolve(stream)),
    createRecorder: (_s, mime) => {
      const r = new FakeRecorder(mime ?? 'audio/webm');
      recorders.push(r);
      return r as unknown as MediaRecorder;
    },
    isTypeSupported: (t) => supported.includes(t),
    createMeter: () => meter,
    now: () => now,
  };
  const onLimit = vi.fn();
  const recorder = new VoiceRecorder(deps, onLimit);
  return {
    recorder,
    track,
    meter,
    onLimit,
    advance: (ms: number) => {
      now += ms;
      vi.advanceTimersByTime(ms);
    },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('VoiceRecorder (CHAT-074)', () => {
  it('prefers Opus, then AAC', () => {
    expect(pickRecordingMime((t) => t === 'audio/mp4')).toBe('audio/mp4');
    expect(pickRecordingMime(() => true)).toBe('audio/webm;codecs=opus');
    expect(pickRecordingMime(() => false)).toBeUndefined();
  });

  it('records with length, waveform and type, then lets go of the microphone', async () => {
    const { recorder, track, meter, advance } = setUp();
    await recorder.start();
    expect(recorder.getSnapshot().phase).toBe('recording');
    advance(3_000);
    expect(recorder.getSnapshot().elapsedMs).toBe(3_000);
    expect(recorder.getSnapshot().levels.length).toBeGreaterThan(0);
    const result = await recorder.finish();
    expect(result).toMatchObject({
      contentType: 'audio/webm;codecs=opus',
      voice: { durationMs: 3_000 },
    });
    expect(result!.voice.waveform).toHaveLength(VOICE.waveformBars);
    expect(result!.blob.size).toBeGreaterThan(0);
    expect(track.stop).toHaveBeenCalled();
    expect(meter.close).toHaveBeenCalled();
    expect(recorder.getSnapshot().phase).toBe('idle');
  });

  it('drops a mis-click and a cancelled recording', async () => {
    const { recorder, track, advance } = setUp();
    await recorder.start();
    advance(MIN_VOICE_MS - 100);
    expect(await recorder.finish()).toBeNull();
    await recorder.start();
    advance(5_000);
    recorder.cancel();
    expect(recorder.getSnapshot().phase).toBe('idle');
    expect(track.stop).toHaveBeenCalledTimes(2);
    expect(await recorder.finish()).toBeNull();
  });

  it('stops itself at 5 minutes', async () => {
    const { recorder, onLimit, advance } = setUp();
    await recorder.start();
    advance(VOICE.maxSeconds * 1000 - 200);
    expect(onLimit).not.toHaveBeenCalled();
    advance(300);
    expect(onLimit).toHaveBeenCalled();
    const result = await recorder.finish();
    expect(result!.voice.durationMs).toBe(VOICE.maxSeconds * 1000);
  });

  it('reports a refused microphone and stays idle', async () => {
    const { recorder } = setUp();
    const denied = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    (recorder as unknown as { deps: RecorderDeps }).deps.getUserMedia = () =>
      Promise.reject(denied);
    await expect(recorder.start()).rejects.toBe(denied);
    expect(recorder.getSnapshot().phase).toBe('idle');
  });
});
