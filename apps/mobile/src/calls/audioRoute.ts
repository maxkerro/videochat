import type { CallMedia } from '@videochat/shared';

/** Where the call's sound comes out. */
export type AudioRoute = 'earpiece' | 'speaker' | 'bluetooth' | 'headset';

export interface AudioDeviceStatus {
  available: AudioRoute[];
  selected: AudioRoute | null;
}

/** The names the Android audio manager (react-native-incall-manager) uses for each route. */
export const NATIVE_ROUTE: Record<AudioRoute, string> = {
  earpiece: 'EARPIECE',
  speaker: 'SPEAKER_PHONE',
  bluetooth: 'BLUETOOTH',
  headset: 'WIRED_HEADSET',
};

const FROM_NATIVE = new Map(
  (Object.entries(NATIVE_ROUTE) as [AudioRoute, string][]).map(([route, name]) => [name, route]),
);

export const ROUTE_LABEL: Record<AudioRoute, string> = {
  earpiece: 'Phone',
  speaker: 'Speaker',
  bluetooth: 'Bluetooth',
  headset: 'Headset',
};

/** Routes that come from something plugged in or paired, as opposed to the phone's own. */
const EXTERNAL: AudioRoute[] = ['bluetooth', 'headset'];
const ORDER: AudioRoute[] = ['earpiece', 'speaker', 'bluetooth', 'headset'];

/** Reads the `onAudioDeviceChanged` payload: `{ availableAudioDeviceList: '["EARPIECE",...]',
 *  selectedAudioDevice: 'EARPIECE' }`. Anything unrecognised is ignored. */
export function parseDeviceStatus(raw: unknown): AudioDeviceStatus {
  const data = (raw ?? {}) as { availableAudioDeviceList?: unknown; selectedAudioDevice?: unknown };
  let names: unknown = data.availableAudioDeviceList;
  if (typeof names === 'string') {
    try {
      names = JSON.parse(names);
    } catch {
      names = [];
    }
  }
  const found = new Set<AudioRoute>();
  if (Array.isArray(names)) {
    for (const name of names) {
      const route = typeof name === 'string' ? FROM_NATIVE.get(name) : undefined;
      if (route) found.add(route);
    }
  }
  const selected =
    typeof data.selectedAudioDevice === 'string'
      ? (FROM_NATIVE.get(data.selectedAudioDevice) ?? null)
      : null;
  return { available: ORDER.filter((r) => found.has(r)), selected };
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
}

/**
 * CHAT-062: the call's audio routing. It starts the platform audio manager for the call, applies
 * the default route (speaker for video, earpiece for audio, a headset or Bluetooth device when
 * one is connected), moves the sound to a headset the moment one connects, and remembers an
 * explicit pick for as long as it stays possible. The platform's own default is left alone at the
 * start (so a call never blinks through the loudspeaker); the first device report says what it is.
 */
export class AudioSession {
  private media: CallMedia = 'audio';
  private running = false;
  private available: AudioRoute[] = [];
  private current: AudioRoute | null = null;
  private picked: AudioRoute | null = null;
  private unwatch: (() => void) | null = null;
  private snap: AudioSnapshot = { route: null, choices: routeChoices([]) };
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
    this.available = [];
    this.current = null;
    this.driver.start(media);
    // The platform audio manager has already chosen the same default (speaker for video, earpiece
    // for audio, a headset first); the first device report tells us what it picked.
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
      this.apply(arrived[0]!);
    } else if (gone) {
      // The headset was unplugged / disconnected: back to the phone.
      if (this.picked !== null && !status.available.includes(this.picked)) this.picked = null;
      this.apply(this.picked ?? defaultRoute(this.media, status.available));
    } else if (status.selected !== null && status.selected !== this.current) {
      this.current = status.selected;
    }
    this.publish();
  }

  private apply(route: AudioRoute): void {
    this.current = route;
    this.driver.choose(route);
    this.publish();
  }

  private publish(): void {
    this.snap = { route: this.current, choices: routeChoices(this.available) };
    for (const listener of this.listeners) listener();
  }
}
