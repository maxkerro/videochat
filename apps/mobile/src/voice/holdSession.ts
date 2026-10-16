import { isCancelSlide, type CapturedVoice, type VoiceCapture } from './capture';

export interface RecordingState {
  recording: boolean;
  elapsedMs: number;
  levels: number[];
  /** The finger has slid far enough left: letting go throws it away. */
  cancelling: boolean;
}

export const IDLE_RECORDING: RecordingState = {
  recording: false,
  elapsedMs: 0,
  levels: [],
  cancelling: false,
};

export interface HoldHandlers {
  disabledReason: string | null;
  onRecorded: (voice: CapturedVoice) => void;
  onState: (state: RecordingState) => void;
}

export interface HoldDeps {
  /** True when recording may start; asks for the microphone the first time (then false: the
   *  finger has long let go by the time the person answers). */
  ensurePermission: () => Promise<boolean>;
  alert: (title: string, message: string) => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
}

/**
 * CHAT-074: hold to record, let go to send, slide left to cancel -- the logic behind the
 * microphone button, outside React so it can be tested. A screen reader's double-tap starts and a
 * second one sends. Stops and sends by itself at 5 minutes.
 */
export class HoldToRecord {
  private handlers: HoldHandlers;
  private cancelling = false;
  private timer: unknown = null;
  private pressed = false;
  active = false;

  constructor(
    private readonly capture: VoiceCapture,
    private readonly deps: HoldDeps,
    handlers: HoldHandlers,
  ) {
    this.handlers = handlers;
  }

  update(handlers: HoldHandlers): void {
    this.handlers = handlers;
  }

  /** Finger down (or a screen reader's first double-tap). */
  async begin(): Promise<boolean> {
    if (this.active) return false;
    this.pressed = true;
    if (this.handlers.disabledReason) {
      this.deps.alert('Can’t record now', this.handlers.disabledReason);
      return false;
    }
    if (!(await this.deps.ensurePermission())) return false;
    try {
      await this.capture.start();
    } catch {
      this.deps.alert('Couldn’t start recording', 'Try again in a moment.');
      return false;
    }
    if (!this.pressed) {
      // Let go before the microphone was ready: a tap, not a recording.
      await this.capture.cancel();
      return false;
    }
    this.cancelling = false;
    this.active = true;
    this.handlers.onState({ recording: true, elapsedMs: 0, levels: [], cancelling: false });
    this.timer = this.deps.setInterval(() => this.tick(), 100);
    return true;
  }

  /** The finger moved `dx` from where it went down. */
  move(dx: number): void {
    this.cancelling = isCancelSlide(dx);
  }

  /** Finger up: send, unless slid away to cancel. */
  release(): Promise<void> {
    this.pressed = false;
    return this.end(!this.cancelling);
  }

  async end(send: boolean): Promise<void> {
    this.pressed = false;
    if (this.timer !== null) this.deps.clearInterval(this.timer);
    this.timer = null;
    const wasActive = this.active;
    this.active = false;
    if (wasActive) this.handlers.onState(IDLE_RECORDING);
    if (!this.capture.recording) return;
    if (!send) {
      await this.capture.cancel();
      return;
    }
    const result = await this.capture.finish().catch(() => null);
    if (result) this.handlers.onRecorded(result);
  }

  private tick(): void {
    const s = this.capture.sample();
    this.handlers.onState({
      recording: true,
      elapsedMs: s.elapsedMs,
      levels: s.levels,
      cancelling: this.cancelling,
    });
    if (s.atLimit) void this.end(true);
  }
}
