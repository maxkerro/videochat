import { VOICE, levelFromDecibels, waveformFromLevels, type VoiceInfo } from '@videochat/shared';

/** CHAT-074: the parts of a recorder this needs (expo-audio's AudioRecorder in the app). */
export interface RecorderAdapter {
  start(): Promise<void>;
  /** Stops and returns where the file was written. */
  stop(): Promise<string | null>;
  /** Loudness right now in decibels (undefined if unknown). */
  metering(): number | undefined;
}

/** Shorter than this is a tap, not a message. */
export const MIN_VOICE_MS = 700;
/** Sliding a finger this far left from the microphone button cancels the recording. */
export const CANCEL_SLIDE_PX = 100;

export const isCancelSlide = (dx: number) => dx <= -CANCEL_SLIDE_PX;

export interface CapturedVoice {
  uri: string;
  voice: VoiceInfo;
}

/**
 * CHAT-074: one hold-to-record recording. `sample` is called every ~100 ms while recording, for
 * the waveform and the elapsed time; `finish` returns the file (null if it was only a tap),
 * `cancel` throws it away.
 */
export class VoiceCapture {
  private levels: number[] = [];
  private startedAt = 0;
  private active = false;

  constructor(
    private readonly recorder: RecorderAdapter,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async start(): Promise<void> {
    this.levels = [];
    await this.recorder.start();
    this.startedAt = this.now();
    this.active = true;
  }

  /** Records the current loudness; returns the elapsed time and recent levels (0..1). */
  sample(): { elapsedMs: number; levels: number[]; atLimit: boolean } {
    if (!this.active) return { elapsedMs: 0, levels: [], atLimit: false };
    this.levels.push(levelFromDecibels(this.recorder.metering()));
    const elapsedMs = this.now() - this.startedAt;
    return {
      elapsedMs,
      levels: this.levels.slice(-32),
      atLimit: elapsedMs >= VOICE.maxSeconds * 1000,
    };
  }

  async finish(): Promise<CapturedVoice | null> {
    if (!this.active) return null;
    this.active = false;
    const durationMs = Math.min(this.now() - this.startedAt, VOICE.maxSeconds * 1000);
    const uri = await this.recorder.stop();
    if (!uri || durationMs < MIN_VOICE_MS) return null;
    return { uri, voice: { durationMs, waveform: waveformFromLevels(this.levels) } };
  }

  async cancel(): Promise<void> {
    if (!this.active) return;
    this.active = false;
    await this.recorder.stop().catch(() => null);
  }

  get recording(): boolean {
    return this.active;
  }
}
