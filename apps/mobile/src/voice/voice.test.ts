import { VOICE } from '@videochat/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CANCEL_SLIDE_PX, MIN_VOICE_MS, VoiceCapture, type RecorderAdapter } from './capture';
import { HoldToRecord, IDLE_RECORDING, type HoldDeps, type RecordingState } from './holdSession';
import { VoicePlayback, type PlayerAdapter, type PlayerStatus } from './playback';

function fakeRecorder() {
  const recorder = {
    started: 0,
    stopped: 0,
    db: -20 as number | undefined,
    start: vi.fn(async () => {
      recorder.started += 1;
    }),
    stop: vi.fn(async () => {
      recorder.stopped += 1;
      return 'file:///voice.m4a';
    }),
    metering: () => recorder.db,
  };
  return recorder satisfies RecorderAdapter;
}

describe('VoiceCapture (CHAT-074)', () => {
  it('records length and a waveform from the levels', async () => {
    let now = 0;
    const rec = fakeRecorder();
    const capture = new VoiceCapture(rec, () => now);
    await capture.start();
    for (let i = 0; i < 30; i++) {
      now += 100;
      rec.db = i % 2 ? -10 : -50;
      capture.sample();
    }
    const result = await capture.finish();
    expect(result).toMatchObject({ uri: 'file:///voice.m4a', voice: { durationMs: 3000 } });
    expect(result!.voice.waveform).toHaveLength(VOICE.waveformBars);
    expect(Math.max(...result!.voice.waveform)).toBe(100);
  });

  it('treats a tap as nothing, reports the 5-minute limit, and cancels', async () => {
    let now = 0;
    const rec = fakeRecorder();
    const capture = new VoiceCapture(rec, () => now);
    await capture.start();
    now += MIN_VOICE_MS - 1;
    expect(await capture.finish()).toBeNull();

    await capture.start();
    now += VOICE.maxSeconds * 1000;
    expect(capture.sample().atLimit).toBe(true);
    now += 10_000;
    expect((await capture.finish())!.voice.durationMs).toBe(VOICE.maxSeconds * 1000);

    await capture.start();
    await capture.cancel();
    expect(capture.recording).toBe(false);
    expect(await capture.finish()).toBeNull();
  });
});

describe('HoldToRecord (CHAT-074)', () => {
  let now: number;
  let tick: (() => void) | null;
  let states: RecordingState[];
  let sent: unknown[];
  let alerts: string[];
  let rec: ReturnType<typeof fakeRecorder>;
  let permission: boolean;

  function make(disabledReason: string | null = null) {
    const deps: HoldDeps = {
      ensurePermission: async () => permission,
      alert: (title) => alerts.push(title),
      setInterval: (fn) => {
        tick = fn;
        return 1;
      },
      clearInterval: () => {
        tick = null;
      },
    };
    return new HoldToRecord(new VoiceCapture(rec, () => now), deps, {
      disabledReason,
      onRecorded: (v) => sent.push(v),
      onState: (s) => states.push(s),
    });
  }
  const advance = (ms: number) => {
    for (let t = 0; t < ms; t += 100) {
      now += 100;
      tick?.();
    }
  };

  beforeEach(() => {
    now = 0;
    tick = null;
    states = [];
    sent = [];
    alerts = [];
    rec = fakeRecorder();
    permission = true;
  });

  it('hold, then let go: sends', async () => {
    const hold = make();
    await hold.begin();
    advance(2000);
    expect(states.at(-1)).toMatchObject({ recording: true, elapsedMs: 2000, cancelling: false });
    await hold.release();
    expect(sent).toHaveLength(1);
    expect(states.at(-1)).toEqual(IDLE_RECORDING);
  });

  it('slide left past the line, then let go: cancels (and can slide back)', async () => {
    const hold = make();
    await hold.begin();
    advance(1500);
    hold.move(-CANCEL_SLIDE_PX - 5);
    advance(100);
    expect(states.at(-1)!.cancelling).toBe(true);
    hold.move(-20);
    hold.move(-CANCEL_SLIDE_PX);
    await hold.release();
    expect(sent).toHaveLength(0);
    expect(rec.stopped).toBe(1);
  });

  it('stops and sends by itself at 5 minutes', async () => {
    const hold = make();
    await hold.begin();
    advance(VOICE.maxSeconds * 1000);
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toHaveLength(1);
    expect(hold.active).toBe(false);
  });

  it("doesn't record during a call, or before the microphone is allowed", async () => {
    const inCall = make('Finish the call first.');
    expect(await inCall.begin()).toBe(false);
    expect(alerts).toEqual(['Can’t record now']);
    permission = false;
    expect(await make().begin()).toBe(false);
    expect(rec.started).toBe(0);
  });

  it('a quick tap released before the microphone was ready records nothing', async () => {
    const hold = make();
    const starting = hold.begin();
    void hold.release();
    expect(await starting).toBe(false);
    expect(sent).toHaveLength(0);
    expect(hold.active).toBe(false);
  });
});

describe('VoicePlayback (CHAT-074)', () => {
  function fakePlayer() {
    let listener: ((s: PlayerStatus) => void) | null = null;
    const p = {
      loaded: [] as string[],
      playing: false,
      rate: 1,
      seeks: [] as number[],
      nowPlaying: null as string | null,
      prepare: vi.fn(async () => undefined),
      load: (uri: string) => p.loaded.push(uri),
      play: () => {
        p.playing = true;
        listener?.({ currentTimeSec: 0, playing: true, didJustFinish: false, failed: false });
      },
      pause: () => {
        p.playing = false;
        listener?.({ currentTimeSec: 1, playing: false, didJustFinish: false, failed: false });
      },
      seek: async (s: number) => {
        p.seeks.push(s);
      },
      setRate: (r: number) => {
        p.rate = r;
      },
      onStatus: (l: (s: PlayerStatus) => void) => {
        listener = l;
        return () => undefined;
      },
      setNowPlaying: (title: string | null) => {
        p.nowPlaying = title;
      },
      emit: (s: Partial<PlayerStatus>) =>
        listener?.({
          currentTimeSec: 0,
          playing: false,
          didJustFinish: false,
          failed: false,
          ...s,
        }),
    };
    return p;
  }

  function make() {
    const player = fakePlayer();
    const loads: string[] = [];
    const playback = new VoicePlayback(
      () => player as unknown as PlayerAdapter,
      async (id, fresh) => {
        loads.push(`${id}${fresh ? ':fresh' : ''}`);
        return `https://s3.test/${id}${fresh ? '?v=2' : ''}`;
      },
    );
    return { player, loads, playback };
  }

  it('plays in the background with lock-screen controls, pauses and resumes', async () => {
    const { player, playback } = make();
    await playback.toggle('a', 'Voice message from Ben');
    expect(player.prepare).toHaveBeenCalled();
    expect(player.loaded).toEqual(['https://s3.test/a']);
    expect(player.nowPlaying).toBe('Voice message from Ben');
    expect(playback.getSnapshot()).toMatchObject({ attachmentId: 'a', playing: true });
    player.emit({ currentTimeSec: 4.2, playing: true });
    expect(playback.getSnapshot().positionMs).toBe(4200);
    await playback.toggle('a');
    expect(player.playing).toBe(false);
    await playback.toggle('a');
    expect(player.loaded).toHaveLength(1);
    expect(player.playing).toBe(true);
  });

  it('keeps the speed across messages and rewinds at the end', async () => {
    const { player, playback } = make();
    await playback.toggle('a');
    playback.setRate(2);
    await playback.toggle('b');
    expect(player.rate).toBe(2);
    player.emit({ didJustFinish: true });
    expect(playback.getSnapshot()).toMatchObject({ playing: false, positionMs: 0 });
    expect(player.nowPlaying).toBeNull();
  });

  it('retries once with a fresh URL, then shows an error', async () => {
    const { player, loads, playback } = make();
    await playback.toggle('a');
    player.emit({ failed: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(loads).toEqual(['a', 'a:fresh']);
    player.emit({ failed: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(playback.getSnapshot()).toMatchObject({ error: true, playing: false });
  });

  it('stops for a call or sign-out', async () => {
    const { player, playback } = make();
    await playback.toggle('a');
    playback.stop();
    expect(player.playing).toBe(false);
    expect(playback.getSnapshot().attachmentId).toBeNull();
  });
});
