/**
 * CHAT-074: one audio element for every voice message in the app. It lives above the chat (in
 * `VoicePlaybackProvider`), so a message keeps playing when its row scrolls out of the
 * virtualised list -- or when you switch to another chat. Starting another message stops the
 * current one. Components read the state with `useSyncExternalStore`.
 */
export interface VoicePlaybackState {
  /** The voice message playing or paused (null when nothing has been started). */
  attachmentId: string | null;
  playing: boolean;
  loading: boolean;
  positionMs: number;
  /** Playback speed, kept across messages. */
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

export class VoicePlaybackStore {
  private state: VoicePlaybackState = IDLE;
  private readonly listeners = new Set<() => void>();
  private audio: HTMLAudioElement | null = null;
  /** The URL failed once (most likely a signed URL that expired): one fresh one, no more. */
  private retried = false;

  constructor(
    private loadUrl: UrlLoader,
    private readonly createAudio: () => HTMLAudioElement = () => new Audio(),
  ) {}

  /** Where signed URLs come from (swapped as the signed-in session changes). */
  setUrlLoader(loadUrl: UrlLoader): void {
    this.loadUrl = loadUrl;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): VoicePlaybackState => this.state;

  /** Play `attachmentId` (from `positionMs`, or where it was paused), or pause it if it's playing. */
  async toggle(attachmentId: string): Promise<void> {
    if (this.state.attachmentId === attachmentId && this.state.playing) {
      this.pause();
      return;
    }
    const from = this.state.attachmentId === attachmentId ? this.state.positionMs : 0;
    await this.play(attachmentId, from);
  }

  async play(attachmentId: string, fromMs = 0): Promise<void> {
    const audio = this.element();
    const same = this.state.attachmentId === attachmentId && !!audio.src && !this.state.error;
    this.set({ attachmentId, loading: !same, error: false, positionMs: fromMs, playing: false });
    try {
      if (!same) {
        this.retried = false;
        audio.src = await this.loadUrl(attachmentId, false);
        if (this.state.attachmentId !== attachmentId) return; // another message was started
      }
      audio.playbackRate = this.state.rate;
      audio.currentTime = fromMs / 1000;
      await audio.play();
    } catch {
      if (this.state.attachmentId === attachmentId) this.set({ loading: false, error: true });
    }
  }

  pause(): void {
    this.audio?.pause();
  }

  /** Jump within a message; playing continues if it was playing. */
  async seek(attachmentId: string, positionMs: number): Promise<void> {
    if (this.state.attachmentId !== attachmentId) {
      await this.play(attachmentId, positionMs);
      return;
    }
    this.set({ positionMs });
    if (this.audio) this.audio.currentTime = positionMs / 1000;
  }

  setRate(rate: number): void {
    this.set({ rate });
    if (this.audio) this.audio.playbackRate = rate;
  }

  /** Signed out, or the app is going away. */
  stop(): void {
    if (this.audio) {
      this.audio.pause();
      this.audio.removeAttribute('src');
    }
    this.set({ ...IDLE, rate: this.state.rate });
  }

  private element(): HTMLAudioElement {
    if (this.audio) return this.audio;
    const audio = this.createAudio();
    audio.preload = 'auto';
    audio.addEventListener('playing', () => this.set({ playing: true, loading: false }));
    audio.addEventListener('pause', () => this.set({ playing: false }));
    audio.addEventListener('timeupdate', () =>
      this.set({ positionMs: Math.round(audio.currentTime * 1000) }),
    );
    audio.addEventListener('ended', () => this.set({ playing: false, positionMs: 0 }));
    audio.addEventListener('error', () => void this.recover());
    this.audio = audio;
    return audio;
  }

  private async recover(): Promise<void> {
    const { attachmentId, positionMs } = this.state;
    if (!attachmentId || !this.audio) return;
    if (this.retried) {
      this.set({ playing: false, loading: false, error: true });
      return;
    }
    this.retried = true;
    try {
      this.audio.src = await this.loadUrl(attachmentId, true);
      this.audio.currentTime = positionMs / 1000;
      await this.audio.play();
    } catch {
      this.set({ playing: false, loading: false, error: true });
    }
  }

  private set(patch: Partial<VoicePlaybackState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }
}
