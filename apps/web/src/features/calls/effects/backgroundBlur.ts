import { SlowBlurDetector, type BlurStats } from '@videochat/shared';

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

export type { BlurStats } from '@videochat/shared';

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

// CHAT-084: the slowness rule is shared with the phone apps.
export { SLOW_FRAME_MS, SLOW_SECONDS, SlowBlurDetector } from '@videochat/shared';

/** Blur with the watchdog attached: what the call engines use. */
export function blurWithWatchdog(camera: MediaStreamTrack, onSlow: () => void) {
  const detector = new SlowBlurDetector(onSlow);
  return blurTrack(camera, (stats) => detector.report(stats));
}
