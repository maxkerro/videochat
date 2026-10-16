/**
 * CHAT-075: background blur for the camera, with MediaPipe selfie segmentation running on the GPU
 * (WebGL) through LiveKit's track processor. The library, its WebAssembly and the model are only
 * loaded the first time blur is turned on (`/mediapipe/...`, served by this site).
 */
export interface BlurredTrack {
  /** The camera track being blurred. */
  readonly source: MediaStreamTrack;
  /** What to send and show instead. */
  readonly track: MediaStreamTrack;
  stop(): void;
}

export interface BlurStats {
  /** Average time to segment and blur one frame over the last second, in ms. */
  frameMs: number;
}

const base = import.meta.env.BASE_URL.replace(/\/?$/, '/');
export const BLUR_ASSETS = {
  tasksVisionFileSet: `${base}mediapipe/wasm`,
  modelAssetPath: `${base}mediapipe/selfie_segmenter.tflite`,
};

/** Blur strength (px at the processing size). */
const BLUR_RADIUS = 12;
/** Frames per second processed: plenty for a face on a call, and keeps the CPU/GPU cost down. */
export const BLUR_MAX_FPS = 24;

/** Whether this browser can blur at all (WebGL2, VideoFrame, OffscreenCanvas, and a way to
 *  turn frames back into a track). Mirrors the processor's own check without loading it. */
export function canBlurBackground(): boolean {
  if (typeof document === 'undefined') return false;
  const hasFrames =
    typeof OffscreenCanvas !== 'undefined' &&
    typeof VideoFrame !== 'undefined' &&
    typeof createImageBitmap !== 'undefined';
  const hasOutput =
    'MediaStreamTrackProcessor' in globalThis ||
    typeof HTMLCanvasElement.prototype.captureStream === 'function';
  if (!hasFrames || !hasOutput) return false;
  try {
    return !!document.createElement('canvas').getContext('webgl2');
  } catch {
    return false;
  }
}

/** Starts blurring `source`; resolves once the first frames can flow. */
export async function blurTrack(
  source: MediaStreamTrack,
  onStats?: (stats: BlurStats) => void,
): Promise<BlurredTrack> {
  const { BackgroundProcessor } = await import('@livekit/track-processors');
  let total = 0;
  let frames = 0;
  let windowStart = performance.now();
  const processor = BackgroundProcessor({
    mode: 'background-blur',
    blurRadius: BLUR_RADIUS,
    maxFps: BLUR_MAX_FPS,
    assetPaths: BLUR_ASSETS,
    onFrameProcessed: onStats
      ? (s) => {
          total += s.processingTimeMs;
          frames += 1;
          const now = performance.now();
          if (now - windowStart >= 1000) {
            onStats({ frameMs: total / frames });
            total = 0;
            frames = 0;
            windowStart = now;
          }
        }
      : undefined,
  });
  // The processor reads the camera's size (and, without MediaStreamTrackProcessor, its frames)
  // from a video element that nobody sees.
  const element = document.createElement('video');
  element.muted = true;
  element.playsInline = true;
  element.srcObject = new MediaStream([source]);
  await element.play().catch(() => undefined);
  try {
    await processor.init({
      kind: 'video' as never,
      track: source,
      element,
    } as Parameters<typeof processor.init>[0]);
  } catch (error) {
    element.srcObject = null;
    throw error;
  }
  const track = processor.processedTrack;
  if (!track) {
    element.srcObject = null;
    void processor.destroy();
    throw new Error('Background blur produced no video');
  }
  let stopped = false;
  return {
    source,
    track,
    stop: () => {
      if (stopped) return;
      stopped = true;
      void processor.destroy().catch(() => undefined);
      track.stop();
      element.srcObject = null;
    },
  };
}

/** A frame taking longer than this means the device is struggling (at 24 fps a frame has ~42 ms,
 *  shared with everything else the call does). */
export const SLOW_FRAME_MS = 45;
/** ...for this many seconds in a row: blur turns itself off. */
export const SLOW_SECONDS = 5;

/** CHAT-075 (CPU budget): watches the per-second frame times and says when blur is too slow
 *  for this device to keep it on. */
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

/** Blur with the watchdog attached: what the call engines use. */
export function blurWithWatchdog(camera: MediaStreamTrack, onSlow: () => void) {
  const detector = new SlowBlurDetector(onSlow);
  return blurTrack(camera, (stats) => detector.report(stats));
}
