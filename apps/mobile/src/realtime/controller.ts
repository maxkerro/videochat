/** How long the socket stays open after the app goes to the background (CHAT-054: 30 s). */
export const BACKGROUND_GRACE_MS = 30_000;

export interface ConnectionTarget {
  connect(): void;
  close(): void;
}

export interface RealtimeControllerOptions {
  target: ConnectionTarget;
  /** Fired when the app returns to the foreground, whether or not the socket survived the trip,
   *  so the app can catch up on whatever it missed at once (the 2-second AC). */
  onResume: () => void;
  graceMs?: number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (id: ReturnType<typeof setTimeout>) => void;
}

/**
 * CHAT-054: decides when the socket should exist. Connected means: signed in, the device has a
 * network, and the app is in the foreground -- or went to the background less than 30 s ago (a
 * quick app switch shouldn't tear the connection down). It does not look at the socket itself;
 * the client keeps it alive once told to connect.
 */
export function createRealtimeController(options: RealtimeControllerOptions) {
  const grace = options.graceMs ?? BACKGROUND_GRACE_MS;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((id) => clearTimeout(id));

  let signedIn = false;
  let online = true;
  let active = true;
  let graceOver = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let connected = false;

  function apply(): void {
    const want = signedIn && online && (active || !graceOver);
    if (want === connected) return;
    connected = want;
    if (want) options.target.connect();
    else options.target.close();
  }

  return {
    setSignedIn(next: boolean): void {
      signedIn = next;
      apply();
    },
    setOnline(next: boolean): void {
      online = next;
      apply();
    },
    setActive(next: boolean): void {
      if (next === active) return;
      active = next;
      if (next) {
        if (timer !== undefined) clearTimer(timer);
        timer = undefined;
        graceOver = false;
        apply();
        if (signedIn) options.onResume();
      } else {
        graceOver = false;
        timer = setTimer(() => {
          timer = undefined;
          graceOver = true;
          apply();
        }, grace);
      }
    },
    /** True while the controller wants a connection. */
    isWanted: () => connected,
    dispose(): void {
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
      signedIn = false;
      apply();
    },
  };
}
