import { SlowBlurDetector } from '@videochat/shared';

/** CHAT-084: said when blur switched itself off (the web's wording, for a phone). */
export const BLUR_SLOW_NOTICE = 'Background blur was turned off: it was slowing your phone down.';

/** The native side (see modules/video-blur). */
export interface BlurNative {
  isAvailable(): boolean;
  processorName(): string;
  addStatsListener(listener: (frameMs: number) => void): { remove(): void };
}

/** The bit of a react-native-webrtc MediaStreamTrack this needs. */
export interface EffectTrack {
  kind: string;
  readyState?: string;
  _setVideoEffects?(names: string[]): void;
}

export interface BlurState {
  /** This build has the native processor (not Expo Go or an older APK). */
  available: boolean;
  /** Blur is on for this call's camera. */
  on: boolean;
  /** It was turned off because the phone couldn't keep up. */
  turnedOffSlow: boolean;
}

/**
 * CHAT-084: background blur for the camera in 1:1 and group calls. Every camera track a call
 * opens is handed to {@link attach} before it is sent anywhere, so with blur on it is blurred
 * from its first frame. A call starts with the Settings choice; the in-call switch only changes
 * that call. If frames take too long for {@link SLOW_SECONDS} the blur turns itself off and
 * `turnedOffSlow` says so (same rule as the web).
 */
export class BlurController {
  private readonly tracks = new Set<EffectTrack>();
  private state: BlurState;
  private detector: SlowBlurDetector;
  private idle = true;
  private readonly listeners = new Set<() => void>();
  private stats: { remove(): void } | null = null;

  constructor(
    private readonly native: BlurNative,
    private readonly preference: () => boolean,
  ) {
    const available = native.isAvailable();
    this.state = { available, on: available && preference(), turnedOffSlow: false };
    this.detector = this.newDetector();
  }

  getState = (): BlurState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** A camera track was opened for a call: blur it now if blur is on. */
  attach(track: EffectTrack): void {
    if (track.kind !== 'video' || !this.state.available) return;
    this.prune();
    if (this.idle && this.tracks.size === 0) {
      // The first camera of a new call: back to the Settings choice.
      this.detector = this.newDetector();
      this.set({ on: this.preference(), turnedOffSlow: false });
    }
    this.idle = false;
    this.tracks.add(track);
    this.listen();
    this.apply(track);
  }

  /** The in-call switch. */
  setOn(on: boolean): void {
    if (!this.state.available) return;
    if (on) this.detector = this.newDetector();
    this.set({ on, turnedOffSlow: on ? false : this.state.turnedOffSlow });
    this.prune();
    for (const t of this.tracks) this.apply(t);
  }

  /** A call ended: the next one starts from the Settings choice again. */
  callEnded(): void {
    this.idle = true;
    this.prune();
    if (this.tracks.size === 0) {
      this.set({ on: this.state.available && this.preference(), turnedOffSlow: false });
    }
  }

  private report(frameMs: number): void {
    if (this.state.on) this.detector.report({ frameMs });
  }

  private newDetector(): SlowBlurDetector {
    return new SlowBlurDetector(() => {
      if (!this.state.on) return;
      this.setOn(false);
      this.set({ turnedOffSlow: true });
    });
  }

  private listen(): void {
    if (this.stats) return;
    this.stats = this.native.addStatsListener((ms) => this.report(ms));
  }

  private apply(track: EffectTrack): void {
    try {
      track._setVideoEffects?.(this.state.on ? [this.native.processorName()] : []);
    } catch {
      // A track that has just ended can't take effects; nothing to do.
    }
  }

  private prune(): void {
    for (const t of this.tracks) if (t.readyState === 'ended') this.tracks.delete(t);
  }

  private set(patch: Partial<BlurState>): void {
    const next = { ...this.state, ...patch };
    if (next.on === this.state.on && next.turnedOffSlow === this.state.turnedOffSlow) return;
    this.state = next;
    for (const l of this.listeners) l();
  }
}
