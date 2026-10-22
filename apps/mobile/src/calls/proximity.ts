import type { AudioSnapshot } from './audioRoute';

/** The native switch (see modules/proximity-screen). */
export interface ProximityLock {
  setEnabled(enabled: boolean): void;
}

/**
 * CHAT-083: the screen goes off against the ear only during a live audio call whose sound comes
 * out of the earpiece. On the speaker, a headset, Bluetooth, or in a video call the phone isn't
 * held to the face, so it stays on.
 */
export function wantsProximityScreenOff(audio: AudioSnapshot): boolean {
  return audio.active && audio.media === 'audio' && audio.route === 'earpiece';
}

/**
 * Holds the proximity lock exactly while {@link wantsProximityScreenOff} says so, following the
 * call's audio as it changes (route switched, video turned on, call ended).
 */
export class ProximityGuard {
  private held = false;

  constructor(private readonly lock: ProximityLock) {}

  sync(audio: AudioSnapshot): void {
    const want = wantsProximityScreenOff(audio);
    if (want === this.held) return;
    this.held = want;
    this.lock.setEnabled(want);
  }

  /** Lets go (the call screen went away). */
  release(): void {
    if (!this.held) return;
    this.held = false;
    this.lock.setEnabled(false);
  }
}
