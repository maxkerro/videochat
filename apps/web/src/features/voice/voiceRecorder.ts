import { VOICE, waveformFromLevels, type VoiceInfo } from '@videochat/shared';

/** Recording formats in order of preference: Opus where the browser can, AAC (Safari) otherwise. */
const MIME_PREFERENCE = [
  'audio/webm;codecs=opus',
  'audio/ogg;codecs=opus',
  'audio/webm',
  'audio/mp4',
];

export function pickRecordingMime(isSupported: (type: string) => boolean): string | undefined {
  return MIME_PREFERENCE.find((t) => isSupported(t));
}

export interface RecordedVoice {
  blob: Blob;
  contentType: string;
  voice: VoiceInfo;
}

export interface RecorderDeps {
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  createRecorder: (stream: MediaStream, mimeType: string | undefined) => MediaRecorder;
  isTypeSupported: (type: string) => boolean;
  /** Loudness 0..1 of the stream right now, read every LEVEL_INTERVAL_MS. */
  createMeter: (stream: MediaStream) => { level: () => number; close: () => void };
  now: () => number;
}

const LEVEL_INTERVAL_MS = 100;
/** Shorter than this is a mis-click, not a message. */
export const MIN_VOICE_MS = 700;

export type RecorderPhase = 'idle' | 'starting' | 'recording';

export interface RecorderSnapshot {
  phase: RecorderPhase;
  elapsedMs: number;
  /** Recent loudness, 0..1, for the live meter. */
  levels: number[];
}

/**
 * CHAT-074: records one voice message at a time from the microphone (MediaRecorder), measuring
 * loudness for the waveform as it goes. Stops by itself at 5 minutes. `finish` resolves with the
 * recording, or null if it was too short or cancelled.
 */
export class VoiceRecorder {
  private phase: RecorderPhase = 'idle';
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private meter: { level: () => number; close: () => void } | null = null;
  private chunks: Blob[] = [];
  private levels: number[] = [];
  private startedAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private snapshot: RecorderSnapshot = { phase: 'idle', elapsedMs: 0, levels: [] };
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly deps: RecorderDeps,
    /** Called when the 5-minute limit stops the recording. */
    private readonly onLimit: () => void = () => undefined,
  ) {}

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getSnapshot = () => this.snapshot;

  async start(): Promise<void> {
    if (this.phase !== 'idle') return;
    this.setPhase('starting');
    try {
      this.stream = await this.deps.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (error) {
      this.setPhase('idle');
      throw error;
    }
    if ((this.phase as RecorderPhase) !== 'starting') {
      // Cancelled while the permission prompt was up.
      this.release();
      return;
    }
    const mime = pickRecordingMime(this.deps.isTypeSupported);
    this.recorder = this.deps.createRecorder(this.stream, mime);
    this.chunks = [];
    this.levels = [];
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.meter = this.deps.createMeter(this.stream);
    this.recorder.start(250);
    this.startedAt = this.deps.now();
    this.timer = setInterval(() => this.tick(), LEVEL_INTERVAL_MS);
    this.setPhase('recording');
  }

  /** Stops and returns the recording (null when too short). */
  async finish(): Promise<RecordedVoice | null> {
    if (this.phase === 'starting') {
      this.cancel();
      return null;
    }
    const recorder = this.recorder;
    if (this.phase !== 'recording' || !recorder) return null;
    const durationMs = Math.min(this.deps.now() - this.startedAt, VOICE.maxSeconds * 1000);
    const stopped = new Promise<void>((resolve) => {
      recorder.onstop = () => resolve();
    });
    recorder.stop();
    await stopped;
    const contentType = recorder.mimeType || 'audio/webm';
    const blob = new Blob(this.chunks, { type: contentType });
    const levels = this.levels;
    this.release();
    if (durationMs < MIN_VOICE_MS || blob.size === 0) return null;
    return { blob, contentType, voice: { durationMs, waveform: waveformFromLevels(levels) } };
  }

  cancel(): void {
    if (this.recorder && this.recorder.state !== 'inactive') {
      this.recorder.onstop = null;
      this.recorder.stop();
    }
    this.release();
  }

  private tick(): void {
    const level = this.meter?.level() ?? 0;
    this.levels.push(level);
    const elapsedMs = this.deps.now() - this.startedAt;
    this.snapshot = { phase: this.phase, elapsedMs, levels: this.levels.slice(-32) };
    this.emit();
    if (elapsedMs >= VOICE.maxSeconds * 1000) this.onLimit();
  }

  private release(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.meter?.close();
    this.meter = null;
    for (const t of this.stream?.getTracks() ?? []) t.stop();
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
    this.setPhase('idle');
  }

  private setPhase(phase: RecorderPhase): void {
    this.phase = phase;
    this.snapshot = {
      phase,
      elapsedMs: phase === 'idle' ? 0 : this.snapshot.elapsedMs,
      levels: phase === 'idle' ? [] : this.snapshot.levels,
    };
    this.emit();
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}

/** The browser's real microphone, recorder and level meter. */
export const browserRecorderDeps = (): RecorderDeps => ({
  getUserMedia: (c) => navigator.mediaDevices.getUserMedia(c),
  createRecorder: (stream, mimeType) =>
    new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 32_000 }),
  isTypeSupported: (t) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t),
  createMeter: (stream) => {
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    context.createMediaStreamSource(stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    return {
      level: () => {
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (const s of samples) sum += s * s;
        // RMS, lifted so speech fills the meter (a speaking voice is around 0.05-0.3 RMS).
        return Math.min(1, Math.sqrt(sum / samples.length) * 4);
      },
      close: () => void context.close().catch(() => undefined),
    };
  },
  now: () => Date.now(),
});
