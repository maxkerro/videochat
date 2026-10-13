import { registerPushDevice, unregisterPushDevice } from '../data/api';

/** The token this install last registered for the signed-in account (in memory only). */
let registered: string | null = null;
/** A registration that has been sent but not yet confirmed. */
let pending: Promise<void> | null = null;

export async function registerToken(platform: 'android' | 'ios', token: string): Promise<void> {
  if (registered === token) return;
  const attempt = (async () => {
    await registerPushDevice(platform, token);
    registered = token;
  })();
  pending = attempt;
  try {
    await attempt;
  } finally {
    if (pending === attempt) pending = null;
  }
}

/** How long sign-out waits for the server to forget this phone. */
const UNREGISTER_WAIT_MS = 2_000;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Called before sign-out, while the session can still authenticate: the server stops pushing this
 * account's messages to this phone. Bounded and best effort -- but only an optimisation: the server
 * also deletes a phone's token when its login session ends, and refuses to register one for a
 * session that has already ended, so an offline or interrupted sign-out cannot leave it bound.
 * A registration still in flight is awaited first, so its token is known and gets removed too.
 */
export async function unregisterToken(): Promise<void> {
  const inFlight = pending;
  if (inFlight) await Promise.race([inFlight.catch(() => undefined), wait(UNREGISTER_WAIT_MS)]);
  const token = registered;
  registered = null;
  if (!token) return;
  await Promise.race([
    unregisterPushDevice(token).catch(() => undefined),
    wait(UNREGISTER_WAIT_MS),
  ]);
}

export function forgetRegistration(): void {
  registered = null;
}
