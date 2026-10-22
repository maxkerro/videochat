import type { CallMedia } from '@videochat/shared';

/** Where the call's sound comes out. */
export type AudioRoute = 'earpiece' | 'speaker' | 'bluetooth' | 'headset';

export interface AudioDeviceStatus {
  available: AudioRoute[];
  selected: AudioRoute | null;
}

export const ROUTE_LABEL: Record<AudioRoute, string> = {
  earpiece: 'Phone',
  speaker: 'Speaker',
  bluetooth: 'Bluetooth',
  headset: 'Headset',
};

/** Routes that come from something plugged in or paired, as opposed to the phone's own. */
const EXTERNAL: AudioRoute[] = ['bluetooth', 'headset'];
const ORDER: AudioRoute[] = ['earpiece', 'speaker', 'bluetooth', 'headset'];

/** The cross-platform port names the native call library reports (an AVAudioSession port type on
 *  iOS, the same names mapped from the Android audio device type on Android). */
export function routeOfPort(portType: unknown): AudioRoute | null {
  if (typeof portType !== 'string') return null;
  if (portType === 'builtInReceiver') return 'earpiece';
  if (portType === 'builtInSpeaker') return 'speaker';
  if (portType === 'headphones' || portType === 'usbAudio' || portType === 'lineOut')
    return 'headset';
  if (portType.startsWith('bluetooth') || portType === 'carAudio') return 'bluetooth';
  return null;
}

interface NativeRouteInfo {
  currentRoute?: { outputs?: Array<{ portType?: unknown }> };
  availableRoutes?: Array<{ portType?: unknown }>;
}

/**
 * Remembers what the phone can route to. Android only reports the route in use (not the list),
 * so a route seen earlier is kept: the earpiece stays on offer while the speaker is in use, and a
 * headset stays on offer until the system falls back to the earpiece (which it only does once the
 * headset is gone, because it prefers a connected one over the earpiece). Known gap: a headset that
 * disconnects while the speaker is forced stays on offer until the route next changes; picking it
 * then just falls back to the system's choice, and the read-back shows the real route.
 */
export class RouteTracker {
  private readonly seen = new Set<AudioRoute>();

  reset(): void {
    this.seen.clear();
  }

  update(raw: unknown): AudioDeviceStatus {
    const info = (raw ?? {}) as NativeRouteInfo;
    const current = routeOfPort(info.currentRoute?.outputs?.[0]?.portType);
    const listed = (Array.isArray(info.availableRoutes) ? info.availableRoutes : [])
      .map((port) => routeOfPort(port?.portType))
      .filter((route): route is AudioRoute => route !== null);
    if (current === 'earpiece') {
      // The system prefers a connected headset over the earpiece: it is not connected.
      this.seen.delete('bluetooth');
      this.seen.delete('headset');
    }
    if (current === 'bluetooth') this.seen.delete('headset');
    if (current === 'headset') this.seen.delete('bluetooth');
    if (current) this.seen.add(current);
    for (const route of listed) this.seen.add(route);
    return { available: ORDER.filter((r) => this.seen.has(r)), selected: current };
  }
}

/** What a call should use before anyone chooses: an attached headset or Bluetooth first, then the
 *  speaker for video (the phone is held away from the face) and the earpiece for audio. */
export function defaultRoute(media: CallMedia, available: AudioRoute[]): AudioRoute {
  const external = EXTERNAL.find((r) => available.includes(r));
  if (external) return external;
  if (media === 'video' || !available.includes('earpiece')) return 'speaker';
  return 'earpiece';
}

/** The routes to offer: always the speaker, the earpiece when the phone has one, and whatever is
 *  connected. */
export function routeChoices(available: AudioRoute[]): AudioRoute[] {
  const choices = new Set<AudioRoute>(available);
  choices.add('speaker');
  return ORDER.filter((r) => choices.has(r));
}

/** The small part of the platform audio manager this needs. */
export interface AudioDriver {
  start(media: CallMedia): void;
  stop(): void;
  choose(route: AudioRoute): void;
  /** Reports the current devices now and on every change; returns the unsubscribe. */
  watch(listener: (status: AudioDeviceStatus) => void): () => void;
}

export interface AudioSnapshot {
  /** The route in use, once known. */
  route: AudioRoute | null;
  /** What the person can pick. */
  choices: AudioRoute[];
  /** CHAT-083: whether the call's audio is running, and the kind of call it's set up for. */
  active: boolean;
  media: CallMedia;
}

/**
 * CHAT-062: the call's audio routing. It starts the platform audio manager for the call, applies
 * the default route (speaker for video, earpiece for audio, a headset or Bluetooth device when
 * one is connected), moves the sound to a headset the moment one connects, and remembers an
 * explicit pick for as long as it stays possible. Nothing is applied before the first device
 * report (so a call never blinks through the loudspeaker); that report says where the system put it.
 */
export class AudioSession {
  private media: CallMedia = 'audio';
  private running = false;
  private available: AudioRoute[] = [];
  private current: AudioRoute | null = null;
  private picked: AudioRoute | null = null;
  private settled = false;
  private unwatch: (() => void) | null = null;
  private snap: AudioSnapshot = {
    route: null,
    choices: routeChoices([]),
    active: false,
    media: 'audio',
  };
  private readonly listeners = new Set<() => void>();

  constructor(private readonly driver: AudioDriver) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): AudioSnapshot => this.snap;

  isRunning(): boolean {
    return this.running;
  }

  begin(media: CallMedia): void {
    if (this.running) return;
    this.running = true;
    this.media = media;
    this.picked = null;
    this.settled = false;
    this.available = [];
    this.current = null;
    this.driver.start(media);
    // The first device report says where the system put the sound; if that is not the default for
    // this kind of call (video -> speaker), move it then.
    this.unwatch = this.driver.watch((status) => this.onDevices(status));
    this.publish();
  }

  /** The call started or stopped sending video: with nothing chosen yet, follow the default for
   *  the new kind of call (video holds the phone away from the ear). */
  setMedia(media: CallMedia): void {
    if (!this.running || media === this.media) return;
    this.media = media;
    if (this.picked === null && !this.hasExternal())
      this.apply(defaultRoute(media, this.available));
    else this.publish();
  }

  choose(route: AudioRoute): void {
    if (!this.running) return;
    this.picked = route;
    this.apply(route);
  }

  end(): void {
    if (!this.running) return;
    this.running = false;
    this.unwatch?.();
    this.unwatch = null;
    this.driver.stop();
    this.current = null;
    this.picked = null;
    this.settled = false;
    this.available = [];
    this.publish();
  }

  private hasExternal(): boolean {
    return this.available.some((r) => EXTERNAL.includes(r));
  }

  private onDevices(status: AudioDeviceStatus): void {
    const before = this.available;
    this.available = status.available;
    const arrived = status.available.filter((r) => EXTERNAL.includes(r) && !before.includes(r));
    const gone =
      this.current !== null &&
      !status.available.includes(this.current) &&
      this.current !== 'speaker';
    if (arrived.length > 0) {
      // "Connecting a Bluetooth headset moves audio to it automatically."
      this.picked = null;
      // Already there (the system routed it itself): nothing to switch.
      if (status.selected === arrived[0]) this.current = arrived[0]!;
      else this.apply(arrived[0]!);
    } else if (gone) {
      // The headset was unplugged / disconnected: back to the phone.
      if (this.picked !== null && !status.available.includes(this.picked)) this.picked = null;
      this.apply(this.picked ?? defaultRoute(this.media, status.available));
    } else if (status.selected !== null && status.selected !== this.current) {
      this.current = status.selected;
    }
    if (!this.settled && status.selected !== null) {
      this.settled = true;
      const wanted = defaultRoute(this.media, status.available);
      if (arrived.length === 0 && wanted !== status.selected && !EXTERNAL.includes(status.selected))
        this.apply(wanted);
    }
    this.publish();
  }

  private apply(route: AudioRoute): void {
    this.current = route;
    this.driver.choose(route);
    this.publish();
  }

  private publish(): void {
    this.snap = {
      route: this.current,
      choices: routeChoices(this.available),
      active: this.running,
      media: this.media,
    };
    for (const listener of this.listeners) listener();
  }
}
