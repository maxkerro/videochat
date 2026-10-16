/**
 * CHAT-074: one player for every voice message in the app, outside any screen, so a message keeps
 * playing while you scroll the chat, leave it, or lock the phone (background audio). Starting
 * another message stops the current one. The player itself is behind {@link PlayerAdapter}
 * (expo-audio in the app, a fake in tests).
 */
export interface PlayerStatus {
  currentTimeSec: number;
  playing: boolean;
  didJustFinish: boolean;
  /** The source couldn't be played (most likely a signed URL that expired). */
  failed: boolean;
}

export interface PlayerAdapter {
  /** Gets the audio session ready to play (and keep playing in the background). */
  prepare(): Promise<void>;
  load(uri: string): void;
  play(): void;
  pause(): void;
  seek(seconds: number): Promise<void>;
  setRate(rate: number): void;
  onStatus(listener: (status: PlayerStatus) => void): () => void;
  /** Media controls on the lock screen / in the notification shade (needed on Android to keep
   *  playing in the background for long). */
  setNowPlaying(title: string | null): void;
}

export interface VoicePlaybackState {
  attachmentId: string | null;
  playing: boolean;
  loading: boolean;
  positionMs: number;
  rate: number;
  error: boolean;
}

export type UrlLoader = (attachmentId: string, fresh: boolean) => Promise<string>;

const IDLE: VoicePlaybackState = {
  attachmentId: null,
  playing: false,
  loading: false,
  positionMs: 0,
  rate: 1,
  error: false,
};

export class VoicePlayback {
  private state: VoicePlaybackState = IDLE;
  private readonly listeners = new Set<() => void>();
  private loaded = false;
  private retried = false;
  private title = 'Voice message';
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly player: () => PlayerAdapter,
    private readonly loadUrl: UrlLoader,
  ) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): VoicePlaybackState => this.state;

  async toggle(attachmentId: string, title = 'Voice message'): Promise<void> {
    if (this.state.attachmentId === attachmentId && this.state.playing) {
      this.pause();
      return;
    }
    const from = this.state.attachmentId === attachmentId ? this.state.positionMs : 0;
    await this.play(attachmentId, from, title);
  }

  async play(attachmentId: string, fromMs = 0, title = 'Voice message'): Promise<void> {
    const p = this.adapter();
    const same = this.state.attachmentId === attachmentId && this.loaded && !this.state.error;
    this.title = title;
    this.set({ attachmentId, loading: !same, error: false, positionMs: fromMs, playing: false });
    try {
      await p.prepare();
      if (!same) {
        this.retried = false;
        this.loaded = false;
        const uri = await this.loadUrl(attachmentId, false);
        if (this.state.attachmentId !== attachmentId) return; // another message was started
        p.load(uri);
        this.loaded = true;
      }
      p.setRate(this.state.rate);
      if (fromMs > 0) await p.seek(fromMs / 1000);
      p.play();
      p.setNowPlaying(this.title);
    } catch {
      if (this.state.attachmentId === attachmentId) this.set({ loading: false, error: true });
    }
  }

  pause(): void {
    if (this.state.attachmentId) this.adapter().pause();
  }

  async seek(attachmentId: string, positionMs: number): Promise<void> {
    if (this.state.attachmentId !== attachmentId) {
      await this.play(attachmentId, positionMs, this.title);
      return;
    }
    this.set({ positionMs });
    await this.adapter().seek(positionMs / 1000);
  }

  setRate(rate: number): void {
    this.set({ rate });
    if (this.state.attachmentId) this.adapter().setRate(rate);
  }

  /** Signed out, or a call started. */
  stop(): void {
    if (this.state.attachmentId) {
      const p = this.adapter();
      p.pause();
      p.setNowPlaying(null);
    }
    this.loaded = false;
    this.set({ ...IDLE, rate: this.state.rate });
  }

  private adapter(): PlayerAdapter {
    const p = this.player();
    if (!this.unsubscribe) this.unsubscribe = p.onStatus((s) => this.onStatus(s));
    return p;
  }

  private onStatus(s: PlayerStatus): void {
    if (!this.state.attachmentId) return;
    if (s.failed) {
      void this.recover();
      return;
    }
    if (s.didJustFinish) {
      this.set({ playing: false, loading: false, positionMs: 0 });
      this.adapter().setNowPlaying(null);
      void this.adapter().seek(0);
      return;
    }
    this.set({
      playing: s.playing,
      loading: s.playing ? false : this.state.loading,
      positionMs: Math.round(s.currentTimeSec * 1000),
    });
  }

  private async recover(): Promise<void> {
    const { attachmentId, positionMs } = this.state;
    if (!attachmentId) return;
    if (this.retried) {
      this.set({ playing: false, loading: false, error: true });
      return;
    }
    this.retried = true;
    try {
      const p = this.adapter();
      p.load(await this.loadUrl(attachmentId, true));
      if (positionMs > 0) await p.seek(positionMs / 1000);
      p.play();
    } catch {
      this.set({ playing: false, loading: false, error: true });
    }
  }

  private set(patch: Partial<VoicePlaybackState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }
}
