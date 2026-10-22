/**
 * CHAT-075/084: background blur's CPU budget, the same on web and phones. A frame taking longer
 * than this means the device is struggling (at 24 fps a frame has ~42 ms, shared with everything
 * else the call does)...
 */
export const SLOW_FRAME_MS = 45;
/** ...for this many seconds in a row: blur turns itself off. */
export const SLOW_SECONDS = 5;

export interface BlurStats {
  /** Average time to segment and blur one frame over the last second, in ms. */
  frameMs: number;
}

/** Watches the per-second frame times and says when blur is too slow for this device to keep it
 *  on. Fires once. */
export class SlowBlurDetector {
  private slowSeconds = 0;
  private fired = false;
  constructor(private readonly onSlow: () => void) {}

  report(stats: BlurStats): void {
    if (this.fired) return;
    this.slowSeconds = stats.frameMs > SLOW_FRAME_MS ? this.slowSeconds + 1 : 0;
    if (this.slowSeconds >= SLOW_SECONDS) {
      this.fired = true;
      this.onSlow();
    }
  }
}
